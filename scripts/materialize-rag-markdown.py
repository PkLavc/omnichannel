#!/usr/bin/env python3
"""Turn the privacy-safe role JSONL into bounded Markdown upload sources."""
import argparse, json
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--examples-per-role", type=int, default=1000)
    parser.add_argument("--prefix", default="icaiu")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    labels = {"sales": "Comercial", "technical": "Assistência técnica", "customer_care": "SAC e pós-venda", "intake": "Atendimento inicial", "quality": "Qualidade"}
    for source in sorted(args.input_dir.glob("role-corpus/*.jsonl")):
        role = source.stem
        target = args.output_dir / f"{args.prefix}-{role}.md"
        rows = []
        with source.open(encoding="utf-8") as handle:
            for line in handle:
                if len(rows) >= args.examples_per_role: break
                try: rows.append(json.loads(line))
                except json.JSONDecodeError: continue
        with target.open("w", encoding="utf-8") as handle:
            handle.write(f"# iCaiu — RAG do agente {labels.get(role, role)}\n\n")
            handle.write("Este corpus foi extraído de atendimentos históricos, com identificadores pessoais redigidos. Use-o como exemplos de linguagem e processo; confirme preço, prazo, estoque, endereço e política em fontes atuais.\n\n")
            for index, row in enumerate(rows, 1):
                outcome = row.get("outcome", "UNKNOWN")
                handle.write(f"## Exemplo {index} — canal {row.get('channel', 'desconhecido')} — resultado {outcome}\n\n")
                safe_turns = str(row.get("turns", "")).encode("utf-8", "replace").decode("utf-8")
                handle.write(safe_turns.strip() + "\n\n")
    print(f"generated={len(list(args.output_dir.glob('icaiu-*.md')))}")

if __name__ == "__main__":
    main()
