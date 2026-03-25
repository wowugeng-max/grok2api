"""
Models API 路由
"""

from fastapi import APIRouter

from app.services.grok.services.model import ModelService
from app.core.config import get_config


router = APIRouter(tags=["Models"])


@router.get("/models")
async def list_models():
    """OpenAI 兼容 models 列表接口"""
    registry = get_config("model_registry", {}) or {}
    enabled = bool(registry.get("enabled", False))
    remote_ids = set()
    if enabled:
        compact_ids = registry.get("remote_model_ids", [])
        if isinstance(compact_ids, list):
            remote_ids = {str(item or "").strip().lower() for item in compact_ids if str(item or "").strip()}
        elif isinstance(registry.get("remote_models", []), list):
            remote_ids = {
                str(item.get("id") or "").strip().lower()
                for item in registry.get("remote_models", [])
                if isinstance(item, dict) and str(item.get("id") or "").strip()
            }

    models = ModelService.list()
    manual_models = registry.get("manual_models", []) if isinstance(registry.get("manual_models", []), list) else []
    manual_name_by_id = {
        str(item.get("id") or "").strip(): str(item.get("name") or "").strip()
        for item in manual_models
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }
    manual_ids = set(manual_name_by_id.keys())
    data = []

    if remote_ids:
        for rid in sorted(remote_ids):
            mapped = ModelService.get(rid)
            if not mapped:
                data.append(
                    {
                        "id": rid,
                        "name": manual_name_by_id.get(rid) or rid,
                        "object": "model",
                        "created": 0,
                        "owned_by": "xai_remote",
                        "executable": False,
                        "mapped_to": None,
                        "manual": rid in manual_ids,
                    }
                )
                continue

            data.append(
                {
                    "id": rid,
                    "name": manual_name_by_id.get(rid) or rid,
                    "object": "model",
                    "created": 0,
                    "owned_by": "xai_remote",
                    "executable": True,
                    "mapped_to": mapped.model_id,
                    "manual": rid in manual_ids,
                }
            )
    else:
        data = [
            {
                "id": m.model_id,
                "name": m.display_name or m.model_id,
                "object": "model",
                "created": 0,
                "owned_by": "grok2api@chenyme",
                "executable": True,
                "mapped_to": m.model_id,
                "manual": False,
            }
            for m in models
        ]

    existing_ids = {str(item.get("id") or "") for item in data if isinstance(item, dict)}
    for item in manual_models:
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "").strip()
        if not mid:
            continue
        name = str(item.get("name") or mid).strip() or mid
        if mid in existing_ids:
            continue
        mapped = ModelService.get(mid)
        data.append(
            {
                "id": mid,
                "name": name,
                "object": "model",
                "created": 0,
                "owned_by": "manual",
                "executable": bool(mapped),
                "mapped_to": mapped.model_id if mapped else None,
                "manual": True,
            }
        )

    return {"object": "list", "data": data}


__all__ = ["router"]
