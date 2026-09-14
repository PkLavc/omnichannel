#!/usr/bin/env python3
"""Build a privacy-safe, sales-grounded iCaiu RAG corpus from Hablla JSON and XLSX.

The raw export is never modified. Outputs live under omnichannel-data and contain
hashed conversation IDs, redacted text, channel and specialist metadata only.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import tarfile
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PHONE_RE = re.compile(r"(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)")
EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
CPF_RE = re.compile(r"(?<!\d)\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}(?!\d)")
ROLES = {
    "sales": re.compile(r"\b(compr|or[cç]amento|pre[cç]o|valor|produto|modelo|estoque|desconto|promo[cç]|parcel|comprar|vender)\w*\b", re.I),
    "technical": re.compile(r"\b(defeit|erro|falh|quebrad|n[aã]o liga|trav|bateria|tela|repar|diagn[oó]st|consert|testar|configur)\w*\b", re.I),
    "customer_care": re.compile(r"\b(reclama|troca|devolu|reembols|garantia|pedido|entrega|pagamento|cobran|estorno|nota fiscal|p[oó]s[- ]?venda)\w*\b", re.I),
    "intake": re.compile(r".*"),
}

def norm_digits(value: object) -> str:
    if value is None:
        return ""
    raw = str(value).strip()
    if not raw:
        return ""
    if re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?[Ee][+-]?[0-9]+", raw):
        try:
            raw = format(float(raw), ".0f")
        except ValueError:
            pass
    digits = re.sub(r"\D", "", raw)
    return digits.lstrip("0") or "0" if digits else ""

def hash_id(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]

def redact(text: str, names: list[str]) -> str:
    value = str(text or "").replace("\r", "").strip()
    for name in sorted({n.strip() for n in names if len(n.strip()) >= 3}, key=len, reverse=True):
        value = re.sub(re.escape(name), "[CLIENTE]", value, flags=re.I)
    value = EMAIL_RE.sub("[EMAIL]", value)
    value = CPF_RE.sub("[DOCUMENTO]", value)
    value = PHONE_RE.sub("[TELEFONE]", value)
    return re.sub(r"\n{3,}", "\n\n", value).strip()

def xlsx_rows(path: Path, sheet_names: set[str]) -> list[dict[str, str]]:
    with zipfile.ZipFile(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(node.text or "" for node in item.iter(f"{{{NS['m']}}}t")) for item in root]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relmap = {item.attrib["Id"]: item.attrib["Target"] for item in rels}
        out: list[dict[str, str]] = []
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            name = sheet.attrib.get("name", "")
            if name not in sheet_names:
                continue
            target = relmap[sheet.attrib[f"{{{NS['r']}}}id"]].lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            root = ET.fromstring(archive.read(target))
            rows = root.findall(".//m:sheetData/m:row", NS)
            if not rows:
                continue
            headers: list[str] = []
            for cell in rows[0].findall("m:c", NS):
                ref = cell.attrib.get("r", "A1")
                col = re.sub(r"\d", "", ref)
                while len(headers) <= sum((ord(c) - 64) * 26 ** i for i, c in enumerate(reversed(col))) - 1:
                    headers.append("")
                headers[sum((ord(c) - 64) * 26 ** i for i, c in enumerate(reversed(col))) - 1] = cell_value(cell, shared)
            for row in rows[1:]:
                values: dict[str, str] = {}
                for cell in row.findall("m:c", NS):
                    ref = cell.attrib.get("r", "A1")
                    col = re.sub(r"\d", "", ref)
                    idx = sum((ord(c) - 64) * 26 ** i for i, c in enumerate(reversed(col))) - 1
                    if idx < len(headers) and headers[idx]:
                        values[headers[idx].strip().casefold()] = cell_value(cell, shared)
                if values:
                    out.append(values)
        return out

def cell_value(cell: ET.Element, shared: list[str]) -> str:
    value = cell.find("m:v", NS)
    raw = "" if value is None else value.text or ""
    if cell.attrib.get("t") == "s" and raw:
        try:
            return shared[int(raw)]
        except (ValueError, IndexError):
            return raw
    return raw

def field(row: dict[str, str], *names: str) -> str:
    for name in names:
        if name.casefold() in row and row[name.casefold()].strip():
            return row[name.casefold()].strip()
    return ""

def successful_identifiers(sales_dir: Path) -> tuple[set[str], set[str], dict[str, int]]:
    phones: set[str] = set(); documents: set[str] = set(); stats = Counter()
    workbooks = sorted(sales_dir.glob("*.xlsx"), key=lambda item: item.stat().st_mtime, reverse=True)
    # The current workbook already contains the consolidated ERP/Faturamento
    # sheets; the larger backup is retained as an audit source, not parsed twice.
    for workbook in workbooks[:1]:
        for row in xlsx_rows(workbook, {"ERP", "Faturamento"}):
            status = field(row, "status venda", "venda.status do sistema", "status do agendamento")
            successful = "fatur" in status.casefold() or "realizou" in status.casefold() or "realizado" in status.casefold()
            if not successful:
                continue
            phone = norm_digits(field(row, "telefone cliente", "cliente.telefone", "telefone de contato", "contato"))
            document = norm_digits(field(row, "cpf/cnpj cliente", "cliente.cpf/cnpj", "cpf do cliente"))
            if phone: phones.add(phone)
            if document: documents.add(document)
            stats["successful_rows"] += 1
    stats["successful_phones"] = len(phones); stats["successful_documents"] = len(documents)
    return phones, documents, dict(stats)

def messages_from(record: dict) -> list[tuple[str, str]]:
    result = []
    for item in record.get("messages", []) if isinstance(record.get("messages"), list) else []:
        if not isinstance(item, dict): continue
        body = item.get("message") if isinstance(item.get("message"), dict) else item
        text = body.get("body") or body.get("content") or body.get("text") or item.get("body") or ""
        if not isinstance(text, str) or not text.strip(): continue
        is_bot = bool(item.get("isBot") is True or item.get("is_bot") is True)
        result.append(("assistant" if is_bot else "user", text.strip()))
    return result

def role_for(text: str, sector: str) -> str:
    normalized = text.casefold()
    if "comercial" in sector.casefold() or "venda" in sector.casefold():
        return "sales"
    for role in ("customer_care", "technical", "sales"):
        if ROLES[role].search(normalized): return role
    return "intake"

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--sales-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--max-exemplars", type=int, default=12000)
    args = parser.parse_args()
    phones, documents, sales_stats = successful_identifiers(args.sales_dir)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    role_dir = args.output_dir / "role-corpus"; role_dir.mkdir(exist_ok=True)
    handles = {role: (role_dir / f"{role}.jsonl").open("w", encoding="utf-8") for role in (*ROLES, "quality")}
    best_sales = (args.output_dir / "sales-success.jsonl").open("w", encoding="utf-8")
    counts = Counter(); channels = Counter(); outcomes = Counter(); examples = 0
    try:
        sources = sorted(args.raw_dir.glob("*.tar.gz"))
        if sources:
            stream = ((member.name, tar.extractfile(member).read()) for archive in sources for tar in [tarfile.open(archive, "r:gz")] for member in tar if member.isfile() and member.name.endswith(".json"))
        else:
            stream = ((str(path), path.read_bytes()) for path in sorted(args.raw_dir.glob("*.json")))
        for source_name, raw_bytes in stream:
            try: record = json.loads(raw_bytes.decode("utf-8"))
            except Exception: counts["invalid_json"] += 1; continue
            connection = str(((record.get("service") or {}).get("connection") or {}).get("name") or "")
            if "icaiu" not in connection.casefold(): continue
            messages = messages_from(record)
            if not messages: counts["without_messages"] += 1; continue
            service = record.get("service") or {}; person = service.get("person") or {}
            phone = norm_digits(record.get("phone") or ((person.get("phones") or [{}])[0].get("phone") if isinstance(person.get("phones"), list) and person.get("phones") else ""))
            cpf = norm_digits(service.get("cpf") or record.get("cpf") or "")
            won = phone in phones or cpf in documents
            channel = str(record.get("channel") or service.get("connection", {}).get("type") or "unknown").casefold()
            combined = " ".join(text for _, text in messages)
            role = role_for(combined, str((service.get("sector") or {}).get("name") or ""))
            names = [str(record.get("contact_name") or ""), str(person.get("name") or "")]
            turns = "\n".join(f"{'Cliente' if who == 'user' else 'Atendente'}: {redact(text, names)}" for who, text in messages[-14:])
            if len(turns) < 80: continue
            item = {"conversationHash": hash_id(str(record.get("conversation_id") or path.stem)), "channel": channel, "agentRole": role, "outcome": "WON" if won else "UNKNOWN", "turns": turns[:12000]}
            handles[role].write(json.dumps(item, ensure_ascii=False) + "\n")
            counts[role] += 1; channels[channel] += 1; outcomes[item["outcome"]] += 1
            if won and role == "sales" and examples < args.max_exemplars:
                best_sales.write(json.dumps(item, ensure_ascii=False) + "\n"); examples += 1
    finally:
        for handle in handles.values(): handle.close()
        best_sales.close()
    summary = {"generatedAt": datetime.now(timezone.utc).isoformat(), "source": {"rawDir": str(args.raw_dir), "salesDir": str(args.sales_dir)}, "salesEvidence": sales_stats, "iCaiu": {"roleDocuments": dict(counts), "channels": dict(channels), "outcomes": dict(outcomes), "salesExemplars": examples}, "privacy": {"rawFilesUnmodified": True, "piiRedacted": True, "conversationIdsHashed": True}}
    (args.output_dir / "manifest.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
