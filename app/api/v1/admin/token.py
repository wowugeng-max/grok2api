import asyncio
import re

import orjson
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.core.auth import get_app_key, verify_app_key
from app.core.batch import create_task, expire_task, get_task
from app.core.logger import logger
from app.core.storage import get_storage
from app.core.proxy_pool import get_proxy_pool_health
from app.services.grok.batch_services.usage import UsageService
from app.services.grok.batch_services.nsfw import NSFWService
from app.services.reverse.accept_tos import AcceptTosReverse
from app.services.reverse.set_birth import SetBirthReverse
from app.services.reverse.nsfw_mgmt import NsfwMgmtReverse
from app.services.reverse.utils.session import ResettableSession
from app.core.exceptions import UpstreamException
from app.core.config import get_config
from app.services.token.manager import get_token_manager

router = APIRouter()

_TOKEN_CHAR_REPLACEMENTS = str.maketrans(
    {
        "\u2010": "-",
        "\u2011": "-",
        "\u2012": "-",
        "\u2013": "-",
        "\u2014": "-",
        "\u2212": "-",
        "\u00a0": " ",
        "\u2007": " ",
        "\u202f": " ",
        "\u200b": "",
        "\u200c": "",
        "\u200d": "",
        "\ufeff": "",
    }
)


def _sanitize_token_text(value) -> str:
    token = "" if value is None else str(value)
    token = token.translate(_TOKEN_CHAR_REPLACEMENTS)
    token = re.sub(r"\s+", "", token)
    if token.startswith("sso="):
        token = token[4:]
    return token.encode("ascii", errors="ignore").decode("ascii")


@router.get("/tokens", dependencies=[Depends(verify_app_key)])
async def get_tokens():
    """获取所有 Token"""
    # 获取消耗模式配置
    from app.core.config import get_config
    mgr = await get_token_manager()
    results = {}
    for pool_name, pool in mgr.pools.items():
        results[pool_name] = [t.model_dump() for t in pool.list()]
    consumed_mode = get_config("token.consumed_mode_enabled", False)
    return {
        "tokens": results or {},
        "consumed_mode_enabled": consumed_mode,
    }


@router.get("/tokens/runtime-metrics", dependencies=[Depends(verify_app_key)])
async def get_token_runtime_metrics():
    """获取 TokenManager 运行时指标（当前 worker 进程内）。"""
    mgr = await get_token_manager()
    return {
        "runtime_metrics": mgr.get_runtime_metrics(),
        "pool_count": len(mgr.pools),
        "token_count": sum(pool.count() for pool in mgr.pools.values()),
    }


@router.get("/tokens/proxy-health", dependencies=[Depends(verify_app_key)])
async def get_token_proxy_health():
    """获取代理池健康状态（当前 worker 进程内）。"""
    health = get_proxy_pool_health()
    return {
        "status": "success",
        "proxy_health": health,
    }


@router.get("/tokens/health-summary", dependencies=[Depends(verify_app_key)])
async def get_token_health_summary():
    """获取 Token 管理链路健康摘要（当前 worker 进程内）。"""
    mgr = await get_token_manager()
    metrics = mgr.get_runtime_metrics()

    refresh_checked = int(metrics.get("refresh_checked_tokens", 0) or 0)
    refresh_recovered = int(metrics.get("refresh_recovered_tokens", 0) or 0)
    refresh_expired = int(metrics.get("refresh_expired_tokens", 0) or 0)
    save_runs = int(metrics.get("save_runs", 0) or 0)
    save_failures = int(metrics.get("save_failures", 0) or 0)
    lock_contention = int(metrics.get("refresh_lock_contention", 0) or 0)

    refresh_recovery_rate = (
        round((refresh_recovered / refresh_checked) * 100, 2)
        if refresh_checked > 0
        else 0.0
    )
    refresh_expired_rate = (
        round((refresh_expired / refresh_checked) * 100, 2)
        if refresh_checked > 0
        else 0.0
    )
    save_failure_rate = (
        round((save_failures / save_runs) * 100, 2)
        if save_runs > 0
        else 0.0
    )

    return {
        "summary": {
            "refresh_checked_tokens": refresh_checked,
            "refresh_recovered_tokens": refresh_recovered,
            "refresh_expired_tokens": refresh_expired,
            "refresh_recovery_rate_pct": refresh_recovery_rate,
            "refresh_expired_rate_pct": refresh_expired_rate,
            "save_runs": save_runs,
            "save_failures": save_failures,
            "save_failure_rate_pct": save_failure_rate,
            "refresh_lock_contention": lock_contention,
        }
    }


@router.post("/tokens", dependencies=[Depends(verify_app_key)])
async def update_tokens(data: dict):
    """更新 Token 信息"""
    storage = get_storage()
    try:
        from app.services.token.models import TokenInfo

        async with storage.acquire_lock("tokens_save", timeout=10):
            existing = await storage.load_tokens() or {}
            normalized = {}
            allowed_fields = set(TokenInfo.model_fields.keys())
            existing_map = {}
            for pool_name, tokens in existing.items():
                if not isinstance(tokens, list):
                    continue
                pool_map = {}
                for item in tokens:
                    if isinstance(item, str):
                        token_data = {"token": item}
                    elif isinstance(item, dict):
                        token_data = dict(item)
                    else:
                        continue
                    raw_token = token_data.get("token")
                    if raw_token is not None:
                        token_data["token"] = _sanitize_token_text(raw_token)
                    token_key = token_data.get("token")
                    if isinstance(token_key, str):
                        pool_map[token_key] = token_data
                existing_map[pool_name] = pool_map
            for pool_name, tokens in (data or {}).items():
                if not isinstance(tokens, list):
                    continue
                pool_list = []
                for item in tokens:
                    if isinstance(item, str):
                        token_data = {"token": item}
                    elif isinstance(item, dict):
                        token_data = dict(item)
                    else:
                        continue

                    raw_token = token_data.get("token")
                    if raw_token is not None:
                        token_data["token"] = _sanitize_token_text(raw_token)
                    if not token_data.get("token"):
                        logger.warning(f"Skip empty token in pool '{pool_name}'")
                        continue

                    base = existing_map.get(pool_name, {}).get(
                        token_data.get("token"), {}
                    )
                    merged = dict(base)
                    merged.update(token_data)
                    if merged.get("tags") is None:
                        merged["tags"] = []

                    filtered = {k: v for k, v in merged.items() if k in allowed_fields}
                    try:
                        info = TokenInfo(**filtered)
                        pool_list.append(info.model_dump())
                    except Exception as e:
                        logger.warning(f"Skip invalid token in pool '{pool_name}': {e}")
                        continue
                normalized[pool_name] = pool_list

            await storage.save_tokens(normalized)
            mgr = await get_token_manager()
            await mgr.reload()
        return {"status": "success", "message": "Token 已更新"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tokens/refresh", dependencies=[Depends(verify_app_key)])
async def refresh_tokens(data: dict):
    """刷新 Token 状态"""
    try:
        mgr = await get_token_manager()
        tokens = []
        if isinstance(data.get("token"), str) and data["token"].strip():
            tokens.append(data["token"].strip())
        if isinstance(data.get("tokens"), list):
            tokens.extend([str(t).strip() for t in data["tokens"] if str(t).strip()])

        if not tokens:
            raise HTTPException(status_code=400, detail="No tokens provided")

        unique_tokens = list(dict.fromkeys(tokens))

        raw_results = await UsageService.batch(
            unique_tokens,
            mgr,
        )

        # 强制保存变更到存储
        await mgr._save(force=True)

        results = {}
        for token, res in raw_results.items():
            results[token] = bool(res.get("ok")) and res.get("data") is True

        response = {"status": "success", "results": results}
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tokens/refresh/async", dependencies=[Depends(verify_app_key)])
async def refresh_tokens_async(data: dict):
    """刷新 Token 状态（异步批量 + SSE 进度）"""
    mgr = await get_token_manager()
    tokens = []
    if isinstance(data.get("token"), str) and data["token"].strip():
        tokens.append(data["token"].strip())
    if isinstance(data.get("tokens"), list):
        tokens.extend([str(t).strip() for t in data["tokens"] if str(t).strip()])

    if not tokens:
        raise HTTPException(status_code=400, detail="No tokens provided")

    unique_tokens = list(dict.fromkeys(tokens))

    task = create_task(len(unique_tokens))

    async def _run():
        try:

            async def _on_item(item: str, res: dict):
                task.record(bool(res.get("ok")) and res.get("data") is True)

            raw_results = await UsageService.batch(
                unique_tokens,
                mgr,
                on_item=_on_item,
                should_cancel=lambda: task.cancelled,
            )

            if task.cancelled:
                task.finish_cancelled()
                return

            results: dict[str, bool] = {}
            ok_count = 0
            fail_count = 0
            for token, res in raw_results.items():
                if res.get("ok") and res.get("data") is True:
                    ok_count += 1
                    results[token] = True
                else:
                    fail_count += 1
                    results[token] = False

            await mgr._save(force=True)

            result = {
                "status": "success",
                "summary": {
                    "total": len(unique_tokens),
                    "ok": ok_count,
                    "fail": fail_count,
                },
                "results": results,
            }
            task.finish(result)
        except Exception as e:
            task.fail_task(str(e))
        finally:
            import asyncio
            asyncio.create_task(expire_task(task.id, 300))

    import asyncio
    asyncio.create_task(_run())

    return {
        "status": "success",
        "task_id": task.id,
        "total": len(unique_tokens),
    }


@router.get("/batch/{task_id}/stream")
async def batch_stream(task_id: str, request: Request):
    app_key = get_app_key()
    if app_key:
        key = request.query_params.get("app_key")
        if key != app_key:
            raise HTTPException(status_code=401, detail="Invalid authentication token")
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    async def event_stream():
        queue = task.attach()
        try:
            yield f"data: {orjson.dumps({'type': 'snapshot', **task.snapshot()}).decode()}\n\n"

            final = task.final_event()
            if final:
                yield f"data: {orjson.dumps(final).decode()}\n\n"
                return

            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    final = task.final_event()
                    if final:
                        yield f"data: {orjson.dumps(final).decode()}\n\n"
                        return
                    continue

                yield f"data: {orjson.dumps(event).decode()}\n\n"
                if event.get("type") in ("done", "error", "cancelled"):
                    return
        finally:
            task.detach(queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/batch/{task_id}/cancel", dependencies=[Depends(verify_app_key)])
async def batch_cancel(task_id: str):
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.cancel()
    return {"status": "success"}


@router.post("/tokens/nsfw/diagnose", dependencies=[Depends(verify_app_key)])
async def diagnose_nsfw(data: dict):
    """诊断单个 Token 的 NSFW 开启链路（ToS -> SetBirth -> NSFW mgmt）。"""
    token = ""
    if isinstance(data, dict):
        if isinstance(data.get("token"), str):
            token = data.get("token", "").strip()

    if not token:
        raise HTTPException(status_code=400, detail="No token provided")

    mgr = await get_token_manager()
    browser = get_config("proxy.browser")
    steps = []

    def _extract_status(err: UpstreamException) -> int:
        if isinstance(err.details, dict) and isinstance(err.details.get("status"), int):
            return err.details["status"]
        return int(getattr(err, "status_code", 502) or 502)

    def _network_hint(status: int) -> str:
        if status == 401:
            return "Token 可能失效或未登录，请检查 token 可用性"
        if status == 403:
            return "疑似代理/CF 被拦截，请检查 proxy.base_proxy_url / proxy.asset_proxy_url / proxy.cf_cookies"
        if status in (429, 503):
            return "上游限流或暂时不可用，请稍后重试"
        if status >= 500:
            return "上游服务异常，请稍后重试"
        return ""

    async with ResettableSession(impersonate=browser) as session:
        try:
            await AcceptTosReverse.request(session, token)
            steps.append({"step": "accept_tos", "ok": True, "status": 200})
        except UpstreamException as e:
            status = _extract_status(e)
            reason = _network_hint(status)
            steps.append(
                {
                    "step": "accept_tos",
                    "ok": False,
                    "status": status,
                    "error": str(e),
                    "hint": reason,
                }
            )
            if status == 401:
                await mgr.record_fail(token, status, "diagnose_tos_auth_failed")
            return {"status": "failed", "failed_step": "accept_tos", "steps": steps}

        try:
            await SetBirthReverse.request(session, token)
            steps.append({"step": "set_birth", "ok": True, "status": 200})
        except UpstreamException as e:
            status = _extract_status(e)
            reason = _network_hint(status)
            steps.append(
                {
                    "step": "set_birth",
                    "ok": False,
                    "status": status,
                    "error": str(e),
                    "hint": reason,
                }
            )
            if status == 401:
                await mgr.record_fail(token, status, "diagnose_set_birth_auth_failed")
            return {"status": "failed", "failed_step": "set_birth", "steps": steps}

        try:
            grpc_status = await NsfwMgmtReverse.request(session, token)
            steps.append(
                {
                    "step": "nsfw_mgmt",
                    "ok": grpc_status.code in (-1, 0),
                    "status": 200,
                    "grpc_status": grpc_status.code,
                    "grpc_message": grpc_status.message or None,
                }
            )
        except UpstreamException as e:
            status = _extract_status(e)
            reason = _network_hint(status)
            steps.append(
                {
                    "step": "nsfw_mgmt",
                    "ok": False,
                    "status": status,
                    "error": str(e),
                    "hint": reason,
                }
            )
            if status == 401:
                await mgr.record_fail(token, status, "diagnose_nsfw_mgmt_auth_failed")
            return {"status": "failed", "failed_step": "nsfw_mgmt", "steps": steps}

    return {
        "status": "success",
        "failed_step": None,
        "steps": steps,
        "message": "NSFW diagnose completed",
    }


@router.post("/tokens/nsfw/enable", dependencies=[Depends(verify_app_key)])
async def enable_nsfw(data: dict):
    """批量开启 NSFW (Unhinged) 模式"""
    try:
        mgr = await get_token_manager()

        tokens = []
        if isinstance(data.get("token"), str) and data["token"].strip():
            tokens.append(data["token"].strip())
        if isinstance(data.get("tokens"), list):
            tokens.extend([str(t).strip() for t in data["tokens"] if str(t).strip()])

        if not tokens:
            for pool_name, pool in mgr.pools.items():
                for info in pool.list():
                    raw = (
                        info.token[4:] if info.token.startswith("sso=") else info.token
                    )
                    tokens.append(raw)

        if not tokens:
            raise HTTPException(status_code=400, detail="No tokens available")

        unique_tokens = list(dict.fromkeys(tokens))

        raw_results = await NSFWService.batch(
            unique_tokens,
            mgr,
        )

        results = {}
        ok_count = 0
        fail_count = 0

        for token, res in raw_results.items():
            masked = f"{token[:8]}...{token[-8:]}" if len(token) > 20 else token
            if res.get("ok") and res.get("data", {}).get("success"):
                ok_count += 1
                results[masked] = res.get("data", {})
            else:
                fail_count += 1
                results[masked] = res.get("data") or {"error": res.get("error")}

        response = {
            "status": "success",
            "summary": {
                "total": len(unique_tokens),
                "ok": ok_count,
                "fail": fail_count,
            },
            "results": results,
        }

        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Enable NSFW failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tokens/nsfw/enable/async", dependencies=[Depends(verify_app_key)])
async def enable_nsfw_async(data: dict):
    """批量开启 NSFW (Unhinged) 模式（异步批量 + SSE 进度）"""
    mgr = await get_token_manager()

    tokens = []
    if isinstance(data.get("token"), str) and data["token"].strip():
        tokens.append(data["token"].strip())
    if isinstance(data.get("tokens"), list):
        tokens.extend([str(t).strip() for t in data["tokens"] if str(t).strip()])

    if not tokens:
        for pool_name, pool in mgr.pools.items():
            for info in pool.list():
                raw = info.token[4:] if info.token.startswith("sso=") else info.token
                tokens.append(raw)

    if not tokens:
        raise HTTPException(status_code=400, detail="No tokens available")

    unique_tokens = list(dict.fromkeys(tokens))

    task = create_task(len(unique_tokens))

    async def _run():
        try:

            async def _on_item(item: str, res: dict):
                ok = bool(res.get("ok") and res.get("data", {}).get("success"))
                task.record(ok)

            raw_results = await NSFWService.batch(
                unique_tokens,
                mgr,
                on_item=_on_item,
                should_cancel=lambda: task.cancelled,
            )

            if task.cancelled:
                task.finish_cancelled()
                return

            results = {}
            ok_count = 0
            fail_count = 0
            for token, res in raw_results.items():
                masked = f"{token[:8]}...{token[-8:]}" if len(token) > 20 else token
                if res.get("ok") and res.get("data", {}).get("success"):
                    ok_count += 1
                    results[masked] = res.get("data", {})
                else:
                    fail_count += 1
                    results[masked] = res.get("data") or {"error": res.get("error")}

            await mgr._save(force=True)

            result = {
                "status": "success",
                "summary": {
                    "total": len(unique_tokens),
                    "ok": ok_count,
                    "fail": fail_count,
                },
                "results": results,
            }
            task.finish(result)
        except Exception as e:
            task.fail_task(str(e))
        finally:
            import asyncio
            asyncio.create_task(expire_task(task.id, 300))

    import asyncio
    asyncio.create_task(_run())

    return {
        "status": "success",
        "task_id": task.id,
        "total": len(unique_tokens),
    }
