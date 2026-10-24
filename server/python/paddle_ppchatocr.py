"""
paddle_ppchatocr.py   (OPTIONAL — only used when PADDLE_KIE_BACKEND=ppchatocr)
─────────────────────────────────────────────────────────────────────────────
Native PP-ChatOCRv4 key-information-extraction backend.

This lets PaddleOCR own the ENTIRE document→JSON pipeline (layout + OCR + KIE)
via its built-in PP-ChatOCRDoc pipeline, instead of the default route
(PP-StructureV3 Markdown → your qwen35 llama-server). Provided for completeness
so you can benchmark it against the llama_server backend.

⚠️ IMPORTANT — PP-ChatOCRv4 needs an LLM/MLLM backend of its own:
   By default it targets Baidu ERNIE (ONLINE, needs an API key). For an offline
   CPU deployment you must point it at an OpenAI-compatible endpoint — your
   qwen35 llama-server works. The chat_bot / retriever config keys and their
   exact names vary across PaddleOCR 3.x point releases, so treat the config
   below as a template and check your installed version's PP-ChatOCRv4 docs:
   https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-ChatOCRv4.html

⚠️ Its generic KIE prompt does NOT know your Greek/myDATA schema (discountN,
   doy, mark, uid, issuer/recipient two-column split). Expect to normalise its
   output into your schema afterwards. For most cases the default
   `llama_server` backend (paddle_kie.py) with your tuned prompt will be more
   accurate for Greek invoices — this file exists for experimentation.

ENV:
  PPCHATOCR_LLM_URL        default = KIE_LLM_URL / QWEN35_SERVICE_URL
  PPCHATOCR_LLM_MODEL      default "qwen35"
  PPCHATOCR_LLM_API_KEY    default "sk-no-key" (llama-server ignores it)
  PPCHATOCR_KEYS           default comma list of fields to extract
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger("paddle_ppchatocr")

PPCHATOCR_LLM_URL = (os.getenv("PPCHATOCR_LLM_URL")
                     or os.getenv("KIE_LLM_URL")
                     or os.getenv("QWEN35_SERVICE_URL")
                     or "http://qwen35:8800").rstrip("/")
PPCHATOCR_LLM_MODEL   = os.getenv("PPCHATOCR_LLM_MODEL", "qwen35")
PPCHATOCR_LLM_API_KEY = os.getenv("PPCHATOCR_LLM_API_KEY", "sk-no-key")
PPCHATOCR_KEYS = os.getenv(
    "PPCHATOCR_KEYS",
    "invoiceNumber,invoiceDate,currency,issuer name,issuer VAT number,"
    "recipient name,recipient VAT number,subtotal,VAT amount,total,MARK",
).split(",")

_pipeline = None


def _chat_config() -> Dict[str, Any]:
    """
    OpenAI-compatible LLM config pointed at the local llama-server.
    The exact key names ('chat_bot' / 'llm_name' / 'base_url' / 'api_type') are
    version-dependent — adjust to your installed PaddleOCR release if it rejects
    them. `api_type: "openai"` + a llama-server base_url is the offline pattern.
    """
    return {
        "chat_bot": {
            "module_name": "chat_bot",
            "model_name": PPCHATOCR_LLM_MODEL,
            "api_type": "openai",
            "base_url": f"{PPCHATOCR_LLM_URL}/v1",
            "api_key": PPCHATOCR_LLM_API_KEY,
        }
    }


def _load():
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    from paddleocr import PPChatOCRv4Doc  # heavy, lazy
    log.info("[PPChatOCR] loading PPChatOCRv4Doc (device=cpu)")
    _pipeline = PPChatOCRv4Doc(
        device=os.getenv("PADDLE_DEVICE", "cpu"),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
    )
    return _pipeline


def extract_invoice_json_native(
        markdown_or_ignored: str = "",
        reference_text: Optional[str] = None,
        pdf_path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Run the native PP-ChatOCRv4 visual_predict → build_vector → chat pipeline.

    NOTE: PP-ChatOCRv4 works on the DOCUMENT (image/PDF), not on Markdown, so
    call this with `pdf_path` set. paddle_kie.py's dispatch passes Markdown; if
    you enable this backend, adapt paddle_ocr_service.py to hand the original PDF
    path/bytes through instead. Returns a dict keyed by PPCHATOCR_KEYS.
    """
    if not pdf_path:
        log.warning("[PPChatOCR] native backend needs the source document "
                    "(pdf_path); Markdown alone is not enough.")
        return None

    pipe = _load()
    key_list: List[str] = [k.strip() for k in PPCHATOCR_KEYS if k.strip()]

    # 1) Visual prediction (layout parsing) — collect visual_info per page.
    visual_info_list = []
    for res in pipe.visual_predict(
            input=pdf_path,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
    ):
        visual_info_list.append(res["visual_info"])

    # 2) Build the vector store from the visual info (for retrieval).
    vector_info = pipe.build_vector(
        visual_info_list,
        flag_save_bytes_vector=True,
        chat_bot_config=_chat_config(),
    )

    # 3) Chat: ask for the invoice keys.
    chat_result = pipe.chat(
        key_list=key_list,
        visual_info=visual_info_list,
        vector_info=vector_info,
        chat_bot_config=_chat_config(),
    )

    # chat_result typically carries {"chat_res": {key: value, ...}}
    out = chat_result.get("chat_res") if isinstance(chat_result, dict) else None
    log.info(f"[PPChatOCR] chat_res keys: {list(out) if isinstance(out, dict) else out}")
    return out if isinstance(out, dict) else None
