# ChessCoach — Interpretable 1850+ Chess Training Engine

A white-box hybrid chess analysis & coaching desktop application designed for tournament players (~1850 USCF) who want to understand **why** moves succeed or fail and build transferable Over-The-Board (OTB) decision habits.

## Key Features

- **Prominent Board-First Interface & Move-Scoped Notes:**
  - Large, high-contrast chessboard with evaluation thermometer, move arrows, and interactive variation stepping (`◀` / `▶`).
  - **Notes appear only when you reach that move:** the side panel displays the Game Summary at the start position, clean move feedback on regular moves, and the full structured coaching breakdown when you step onto a key turning point.
- **Hybrid Search-Tree Interrogation (`chesscoach/interrogator.py`):**
  - **Win-Probability Swing Filter:** Isolates true win-equity turning points rather than noisy centipawn jitter.
  - **TT-Clean Depth-Horizon Curve (`d=1..15`):** Measures whether your move looked tempting at shallow depth (`d=1–2`) and pinpoints the exact ply horizon where the refutation emerges.
  - **Null-Move Pre-Existing Threat Probe:** Distinguishes between *ignoring an existing opponent plan* vs. *creating a brand-new target*.
  - **Multi-PV Singularity & Counterfactual Refuter:** Classifies *Only-Move Tactical Tightropes* vs. *Strategic Landmines* and automatically refutes tempting opponent replies to the recommended best move.
- **6-Dimension White-Box Classical Positional Evaluator (`chesscoach/whitebox_eval.py`):**
  - Scores `Material & Imbalances`, `Pawn Structure & Levers`, `Piece Mobility & Outposts`, `King Safety & File Exposure`, `Space & Central Control`, and `Tactical Stability`, evaluated at quiet settlement leaves so captures settle before structural comparison.
- **Per-Move Live Coach Q&A (`chesscoach/qa_coach.py`):**
  - Ask natural-language questions on any move (e.g., *"What if I played 13. f4 instead?"*, *"Why was Kh1 a mistake?"*, *"What is my opponent threatening?"*) backed by live Stockfish + White-Box probes. Works 100% offline out of the box, with optional Gemini/OpenAI/Anthropic/Ollama API prose grounding.

## Running the Desktop App

1. **Double-click `ChessCoach.exe`** (Windows native launcher) or run:
   ```powershell
   python ChessCoach.py
   ```
   *(Stockfish is downloaded automatically on first launch if not already present.)*

2. **Command-Line PGN Analysis / Web Server:**
   ```powershell
   pip install -r requirements.txt
   python analyze_game.py "__vs_______.__.__.pgn" --color white --title "GCC Classic (White)"
   python analyze_game.py --serve
   ```

3. **Rebuild `ChessCoach.exe` Launcher (requires MinGW `g++`):**
   ```powershell
   python build_app.py
   ```

4. **Run Tests:**
   ```powershell
   python -m pytest -v
   ```
