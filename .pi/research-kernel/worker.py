# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy", "scipy", "sympy", "pandas"]
# ///
"""常驻 Python worker —— 科研 Agent 执行层。

并发模型（无锁、串行、有状态）:
  - 主线程: `for line in sys.stdin` 读取 → json.loads → 入 queue.Queue。
  - 单 worker 线程: 从队列取 job 顺序执行 → 写 result 到真实 stdout。
  - 仅 worker 线程写协议（ready 握手在 worker 线程启动前由主线程写一次），故无需 Lock。
  - 串行执行保证有状态命名空间（持久 namespace dict）无竞争。

协议不变量:
  1. 协议输出走保存的真实 fd（_REAL_STDOUT，在任何重定向前保存）。
  2. 用户代码 print 走 contextlib.redirect_stdout → io.StringIO 捕获，执行后归入 result.stdout。
  3. 每条输出 json.dumps(ensure_ascii=False) + "\n" 后 flush。
"""

import ast
import contextlib
import io
import json
import queue
import sys
import threading
import time
import traceback
from importlib.metadata import PackageNotFoundError, version

# 在任何重定向前保存真实 stdout —— 协议流唯一出口，杜绝被用户代码 print 污染。
_REAL_STDOUT = sys.stdout

# 持久命名空间: 跨 job 保持变量/导入。
_namespace: dict[str, object] = {}

# 待执行 job 队列: 主线程入队，worker 线程出队。
_job_queue: "queue.Queue[dict[str, object] | None]" = queue.Queue()


def _emit(payload: dict[str, object]) -> None:
    """向真实 stdout 写一行协议 JSON 并 flush。"""
    _REAL_STDOUT.write(json.dumps(payload, ensure_ascii=False))
    _REAL_STDOUT.write("\n")
    _REAL_STDOUT.flush()


def _package_versions() -> dict[str, str]:
    """收集已声明科学包版本，供 ready 握手上报。"""
    packages: dict[str, str] = {}
    for name in ("numpy", "scipy", "sympy", "pandas"):
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = "unknown"
    return packages


def _reset_namespace() -> None:
    """清空命名空间并重置内置 —— 等价于全新内核状态。"""
    _namespace.clear()
    _namespace["__builtins__"] = __builtins__


def _run_code(code: str) -> dict[str, object]:
    """执行用户代码，类 Jupyter 末行回显。

    若末节点为 ast.Expr: 前置语句 exec + 末表达式 eval → value_repr/value_type。
    否则整体 exec，value_repr="" / value_type="NoneType"。
    用户 print 经 redirect_stdout 捕获至 StringIO，归入 stdout 字段。
    """
    buffer = io.StringIO()
    value_repr = ""
    value_type = "NoneType"

    try:
        tree = ast.parse(code)
    except SyntaxError:
        # 语法错误: 无捕获输出，直接回报 traceback。
        return {
            "status": "error",
            "stdout": "",
            "error": traceback.format_exc(),
            "error_type": "SyntaxError",
        }

    has_trailing_expr = bool(tree.body) and isinstance(tree.body[-1], ast.Expr)

    try:
        with contextlib.redirect_stdout(buffer):
            if has_trailing_expr:
                # 拆分: 前置语句模块 + 末表达式。
                trailing = tree.body[-1]
                stmt_module = ast.Module(body=tree.body[:-1], type_ignores=[])
                expr = ast.Expression(body=trailing.value)  # type: ignore[attr-defined]
                ast.copy_location(expr, trailing)

                if stmt_module.body:
                    stmt_code = compile(stmt_module, "<cell>", "exec")
                    exec(stmt_code, _namespace)  # noqa: S102 — 受控执行层

                expr_code = compile(expr, "<cell>", "eval")
                value = eval(expr_code, _namespace)  # noqa: S307 — 受控执行层
                value_repr = repr(value)
                value_type = type(value).__name__
            else:
                whole = compile(tree, "<cell>", "exec")
                exec(whole, _namespace)  # noqa: S102 — 受控执行层
    except BaseException as exc:  # noqa: BLE001 — 需捕获用户代码任意异常
        # 部分输出（异常前已 print 的内容）仍归入 stdout。
        return {
            "status": "error",
            "stdout": buffer.getvalue(),
            "error": traceback.format_exc(),
            "error_type": type(exc).__name__,
        }

    return {
        "status": "ok",
        "stdout": buffer.getvalue(),
        "value_repr": value_repr,
        "value_type": value_type,
    }


def _handle_job(job: dict[str, object]) -> None:
    """处理单个 job 并写回协议结果。"""
    job_type = job.get("type")
    job_id = job.get("id")

    if job_type == "ping":
        _emit({"type": "pong"})
        return

    if job_type == "reset":
        start = time.monotonic()
        _reset_namespace()
        _emit(
            {
                "id": job_id,
                "type": "result",
                "status": "ok",
                "stdout": "",
                "value_repr": "",
                "value_type": "NoneType",
                "duration_ms": int((time.monotonic() - start) * 1000),
            }
        )
        return

    if job_type == "exec":
        code = job.get("code")
        start = time.monotonic()
        if not isinstance(code, str):
            _emit(
                {
                    "id": job_id,
                    "type": "result",
                    "status": "error",
                    "stdout": "",
                    "error": "exec job missing string 'code' field",
                    "error_type": "ValueError",
                    "duration_ms": int((time.monotonic() - start) * 1000),
                }
            )
            return

        result = _run_code(code)
        duration_ms = int((time.monotonic() - start) * 1000)
        _emit({"id": job_id, "type": "result", "duration_ms": duration_ms, **result})
        return

    # 未知类型: 静默忽略，避免污染协议流。


def _worker_loop() -> None:
    """worker 线程主循环: 串行消费队列，None 为退出哨兵。"""
    while True:
        job = _job_queue.get()
        if job is None:
            break
        try:
            _handle_job(job)
        except BaseException:  # noqa: BLE001 — 单 job 故障不应杀死 worker
            # _handle_job 内部已处理用户异常; 此处兜底协议层意外。
            job_id = job.get("id") if isinstance(job, dict) else None
            _emit(
                {
                    "id": job_id,
                    "type": "result",
                    "status": "error",
                    "stdout": "",
                    "error": traceback.format_exc(),
                    "error_type": "WorkerError",
                    "duration_ms": 0,
                }
            )


def main() -> None:
    _reset_namespace()

    # 启动握手: 在 worker 线程启动前由主线程写一次。
    _emit(
        {
            "type": "ready",
            "python": "%d.%d.%d" % sys.version_info[:3],
            "packages": _package_versions(),
        }
    )

    worker = threading.Thread(target=_worker_loop, daemon=True)
    worker.start()

    # 主线程: 逐行读 stdin → 解析 → 入队。健壮处理空行/坏 JSON。
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                job = json.loads(line)
            except json.JSONDecodeError:
                continue  # 坏 JSON 静默跳过
            if isinstance(job, dict):
                _job_queue.put(job)
    except KeyboardInterrupt:
        pass

    # stdin EOF: 投递退出哨兵，等 worker 排空当前队列后优雅退出。
    _job_queue.put(None)
    worker.join()


if __name__ == "__main__":
    main()
