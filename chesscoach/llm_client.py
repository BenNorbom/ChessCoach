"""Grounded LLM Client Adapter (Gemini, OpenAI, Anthropic, Local Ollama).

Uses already-installed `httpx` with strict grounding prompts so the LLM
never invents unverified chess variations or evaluations. Falls back cleanly
to `None` when running in zero-key deterministic mode.
"""

from __future__ import annotations

from typing import Any

import httpx

from chesscoach.config import LLMSettings

COACH_SYSTEM_PROMPT = """You are an articulate International Master (2450+ FIDE) chess coach working 1-on-1 with an ambitious 1850 USCF classical tournament player.

STRICT GROUNDING RULES:
1. NEVER invent, guess, or hallucinate chess moves, legalities, board coordinates, or evaluations. Every concrete variation and evaluation you cite MUST come directly from the verified Engine + White-Box Dossier provided to you.
2. Calibrate strictly to an 1850 USCF player: skip beginner platitudes ("develop pieces", "castle early"). Focus on prophylaxis, pawn breaks/levers, outpost preservation, file opening near kings, calculation horizon triggers, candidate-move pruning, and rook/minor-piece endgame technique.
3. Always connect concrete variations to *why* they work structurally (referencing the White-Box feature shifts, null-move threats, and counterfactual refutations) and end with a concise, transferable Over-The-Board (OTB) mental trigger the player can apply in future games.
"""


def is_llm_configured(settings: LLMSettings | None = None) -> bool:
    """Return True if an active LLM provider is configured."""
    cfg = settings or LLMSettings.load()
    prov = (cfg.provider or "").lower()
    if prov in ("", "deterministic", "none", "offline"):
        return False
    if prov == "ollama":
        return True
    return bool(cfg.api_key.strip())


def call_grounded_llm(
    user_prompt: str,
    settings: LLMSettings | None = None,
    system_prompt: str = COACH_SYSTEM_PROMPT,
    timeout_sec: float = 25.0,
) -> str | None:
    """Call configured LLM provider or return None if deterministic/unavailable."""
    cfg = settings or LLMSettings.load()
    if not is_llm_configured(cfg):
        return None

    prov = cfg.provider.lower()
    api_key = cfg.api_key.strip()

    try:
        with httpx.Client(timeout=timeout_sec) as client:
            if prov == "gemini":
                model = cfg.model.strip() or "gemini-2.5-flash"
                url = (
                    f"https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{model}:generateContent?key={api_key}"
                )
                payload: dict[str, Any] = {
                    "system_instruction": {"parts": [{"text": system_prompt}]},
                    "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
                    "generationConfig": {"temperature": 0.35, "maxOutputTokens": 1200},
                }
                resp = client.post(url, json=payload)
                resp.raise_for_status()
                data = resp.json()
                candidates = data.get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    return "".join(p.get("text", "") for p in parts).strip() or None

            elif prov == "openai":
                model = cfg.model.strip() or "gpt-4o-mini"
                base = (cfg.base_url.strip() or "https://api.openai.com/v1").rstrip("/")
                url = f"{base}/chat/completions"
                headers = {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                }
                payload = {
                    "model": model,
                    "temperature": 0.35,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                }
                resp = client.post(url, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"].strip()

            elif prov == "anthropic":
                model = cfg.model.strip() or "claude-3-5-sonnet-latest"
                url = "https://api.anthropic.com/v1/messages"
                headers = {
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                }
                payload = {
                    "model": model,
                    "max_tokens": 1200,
                    "temperature": 0.35,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": user_prompt}],
                }
                resp = client.post(url, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                blocks = data.get("content", [])
                return "".join(b.get("text", "") for b in blocks).strip() or None

            elif prov == "ollama":
                model = cfg.model.strip() or "llama3.1"
                base = (cfg.base_url.strip() or "http://localhost:11434").rstrip("/")
                url = f"{base}/api/chat"
                payload = {
                    "model": model,
                    "stream": False,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                }
                resp = client.post(url, json=payload)
                resp.raise_for_status()
                data = resp.json()
                return data.get("message", {}).get("content", "").strip() or None

    except Exception as exc:
        # Return graceful error hint embedded only for explicit debugging or fallback
        print(f"[ChessCoach LLM fallback] {prov} call failed: {exc}")
        return None

    return None
