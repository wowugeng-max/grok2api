"""Admin model registry management."""

import re
import time
from typing import Any

from curl_cffi.requests import AsyncSession
from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import verify_app_key
from app.core.config import config, get_config
from app.core.logger import logger

router = APIRouter()

_PUBLIC_MODELS_SOURCES = [
    "https://docs.x.ai/developers/models",
    "https://x.ai/api",
]

_MODEL_ID_RE = re.compile(r"\b(grok-[a-z0-9][a-z0-9._-]*)\b", re.I)


def _normalize_registry_models(registry: dict[str, Any]) -> list[dict[str, Any]]:
    """Backward-compatible normalize for remote models storage.

    New compact shape:
      model_registry.remote_model_ids = ["grok-...", ...]

    Legacy shape:
      model_registry.remote_models = [{"id": "...", ...}, ...]
    """
    if not isinstance(registry, dict):
        return []

    ids = registry.get("remote_model_ids", [])
    if isinstance(ids, list):
        out = []
        seen = set()
        for raw in ids:
            mid = str(raw or "").strip().lower()
            if not mid or mid in seen:
                continue
            seen.add(mid)
            out.append({
                "id": mid,
                "object": "model",
                "created": int(registry.get("last_sync_at", 0) or 0),
                "owned_by": "xai_public_docs",
            })
        if out:
            return out

    legacy = registry.get("remote_models", [])
    if isinstance(legacy, list):
        out = []
        seen = set()
        for item in legacy:
            if not isinstance(item, dict):
                continue
            mid = str(item.get("id") or "").strip().lower()
            if not mid or mid in seen:
                continue
            seen.add(mid)
            out.append(
                {
                    "id": mid,
                    "object": "model",
                    "created": int(item.get("created") or 0),
                    "owned_by": str(item.get("owned_by") or "xai_public_docs"),
                }
            )
        return out

    return []


def _local_supported_models() -> set[str]:
    from app.services.grok.services.model import ModelService

    return {m.model_id for m in ModelService.list()}


def _extract_model_ids_from_text(text: str) -> list[str]:
    if not isinstance(text, str) or not text:
        return []
    # 去掉明显的无关词
    deny = {
        "grok-api",
        "grok-login",
        "grok-docs",
    }
    ids = []
    seen = set()
    for m in _MODEL_ID_RE.finditer(text):
        mid = (m.group(1) or "").strip().lower()
        if not mid or mid in seen or mid in deny:
            continue
        # 保留 grok-* 主体模型，避免抓到噪声路径
        if mid.count("-") < 1:
            continue
        seen.add(mid)
        ids.append(mid)
    return ids


async def _fetch_public_models() -> list[dict[str, Any]]:
    timeout = int(get_config("chat.timeout", 60) or 60)
    collected: list[str] = []
    for url in _PUBLIC_MODELS_SOURCES:
        try:
            async with AsyncSession(timeout=timeout) as session:
                res = await session.get(
                    url,
                    headers={"User-Agent": get_config("proxy.user_agent", "Mozilla/5.0")},
                    impersonate=get_config("proxy.browser", "chrome136"),
                )
            if res.status_code != 200:
                continue
            text = res.text or ""
            ids = _extract_model_ids_from_text(text)
            for mid in ids:
                if mid not in collected:
                    collected.append(mid)
        except Exception as e:
            logger.warning(f"Public models fetch failed from {url}: {e}")
            continue

    if not collected:
        raise HTTPException(status_code=502, detail="未能从公开文档提取到模型列表")

    now = int(time.time())
    return [
        {
            "id": mid,
            "object": "model",
            "created": now,
            "owned_by": "xai_public_docs",
        }
        for mid in collected
    ]


@router.get("/models/registry", dependencies=[Depends(verify_app_key)])
async def get_model_registry():
    """Get model registry snapshot for admin UI."""
    from app.services.grok.services.model import ModelService

    registry = get_config("model_registry", {}) or {}
    aliases = registry.get("aliases", {}) if isinstance(registry.get("aliases", {}), dict) else {}
    manual_models = registry.get("manual_models", []) if isinstance(registry.get("manual_models", []), list) else []
    remote_models = _normalize_registry_models(registry)
    remote_ids = [str(m.get("id") or "") for m in remote_models if isinstance(m, dict)]

    supported = _local_supported_models()
    items = []
    for m in remote_models:
        if not isinstance(m, dict):
            continue
        mid = str(m.get("id") or "")
        if not mid:
            continue
        mapped = ModelService.get(mid)
        items.append(
            {
                **m,
                "supported": mid in supported,
                "executable": bool(mapped),
                "mapped_to": mapped.model_id if mapped else None,
            }
        )

    return {
        "status": "success",
        "enabled": bool(registry.get("enabled", False)),
        "source": registry.get("source", "xai_public_docs"),
        "last_sync_at": int(registry.get("last_sync_at", 0) or 0),
        "remote_count": len(remote_ids),
        "supported_count": sum(1 for rid in remote_ids if rid in supported),
        "aliases": aliases,
        "manual_models": manual_models,
        "local_models": sorted(list(supported)),
        "models": items,
    }


@router.post("/models/registry/discover", dependencies=[Depends(verify_app_key)])
async def discover_model_registry(_: dict[str, Any] | None = None):
    """Discover model IDs from public xAI docs pages (no API key required)."""
    normalized = await _fetch_public_models()

    old_registry = get_config("model_registry", {}) or {}
    sync_at = int(time.time())
    merged = {
        "model_registry": {
            "enabled": True,
            "source": "xai_public_docs",
            "last_sync_at": sync_at,
            "remote_model_ids": [str(item.get("id") or "").strip().lower() for item in normalized if isinstance(item, dict) and str(item.get("id") or "").strip()],
            # 写入紧凑结构后清空 legacy 字段，避免 config.toml 暴涨
            "remote_models": [],
            "aliases": old_registry.get("aliases", {}) if isinstance(old_registry.get("aliases", {}), dict) else {},
        }
    }
    await config.update(merged)

    supported = _local_supported_models()
    supported_ids = [m["id"] for m in normalized if m["id"] in supported]
    return {
        "status": "success",
        "remote_count": len(normalized),
        "supported_count": len(supported_ids),
        "source": "xai_public_docs",
        "used_probe_model": "public-docs",
    }


@router.post("/models/registry/manual/upsert", dependencies=[Depends(verify_app_key)])
async def upsert_manual_model(data: dict[str, Any]):
    from app.services.grok.services.model import ModelService

    model_id = str((data or {}).get("id") or "").strip().lower()
    model_name = str((data or {}).get("name") or "").strip()
    mapped_to = str((data or {}).get("mapped_to") or "").strip()
    if not model_id or not model_name:
        raise HTTPException(status_code=400, detail="id and name are required")

    if mapped_to and mapped_to not in {m.model_id for m in ModelService.list()}:
        raise HTTPException(status_code=400, detail=f"mapped_to not supported: {mapped_to}")

    registry = get_config("model_registry", {}) or {}
    manual_models = registry.get("manual_models", []) if isinstance(registry.get("manual_models", []), list) else []
    aliases = registry.get("aliases", {}) if isinstance(registry.get("aliases", {}), dict) else {}

    kept = []
    replaced = False
    for item in manual_models:
        if not isinstance(item, dict):
            continue
        if str(item.get("id") or "").strip().lower() == model_id:
            kept.append({"id": model_id, "name": model_name})
            replaced = True
        else:
            kept.append({"id": str(item.get("id") or "").strip().lower(), "name": str(item.get("name") or "").strip()})
    if not replaced:
        kept.append({"id": model_id, "name": model_name})

    if mapped_to:
        aliases[model_id] = mapped_to
    else:
        aliases.pop(model_id, None)

    await config.update({"model_registry": {"manual_models": kept, "aliases": aliases}})
    return {"status": "success", "manual_models": kept, "mapped_to": mapped_to or None}


@router.post("/models/registry/manual/delete", dependencies=[Depends(verify_app_key)])
async def delete_manual_model(data: dict[str, Any]):
    model_id = str((data or {}).get("id") or "").strip().lower()
    if not model_id:
        raise HTTPException(status_code=400, detail="id is required")

    registry = get_config("model_registry", {}) or {}
    manual_models = registry.get("manual_models", []) if isinstance(registry.get("manual_models", []), list) else []
    aliases = registry.get("aliases", {}) if isinstance(registry.get("aliases", {}), dict) else {}

    kept = []
    for item in manual_models:
        if not isinstance(item, dict):
            continue
        iid = str(item.get("id") or "").strip().lower()
        if iid and iid != model_id:
            kept.append({"id": iid, "name": str(item.get("name") or "").strip()})

    aliases.pop(model_id, None)

    await config.update({"model_registry": {"manual_models": kept, "aliases": aliases}})
    return {"status": "success", "manual_models": kept}


@router.post("/models/registry/alias/upsert", dependencies=[Depends(verify_app_key)])
async def upsert_model_alias(data: dict[str, Any]):
    from app.services.grok.services.model import ModelService

    remote_id = str((data or {}).get("remote_id") or "").strip().lower()
    mapped_to = str((data or {}).get("mapped_to") or "").strip()

    if not remote_id or not mapped_to:
        raise HTTPException(status_code=400, detail="remote_id and mapped_to are required")
    if mapped_to not in {m.model_id for m in ModelService.list()}:
        raise HTTPException(status_code=400, detail=f"mapped_to not supported: {mapped_to}")

    registry = get_config("model_registry", {}) or {}
    aliases = registry.get("aliases", {}) if isinstance(registry.get("aliases", {}), dict) else {}
    aliases[remote_id] = mapped_to

    await config.update({"model_registry": {"aliases": aliases}})
    return {"status": "success", "aliases": aliases}


@router.post("/models/registry/alias/delete", dependencies=[Depends(verify_app_key)])
async def delete_model_alias(data: dict[str, Any]):
    remote_id = str((data or {}).get("remote_id") or "").strip().lower()
    if not remote_id:
        raise HTTPException(status_code=400, detail="remote_id is required")

    registry = get_config("model_registry", {}) or {}
    aliases = registry.get("aliases", {}) if isinstance(registry.get("aliases", {}), dict) else {}
    aliases.pop(remote_id, None)

    await config.update({"model_registry": {"aliases": aliases}})
    return {"status": "success", "aliases": aliases}


@router.post("/models/registry/enable", dependencies=[Depends(verify_app_key)])
async def enable_model_registry():
    await config.update({"model_registry": {"enabled": True}})
    return {"status": "success"}


@router.post("/models/registry/disable", dependencies=[Depends(verify_app_key)])
async def disable_model_registry():
    await config.update({"model_registry": {"enabled": False}})
    return {"status": "success"}
