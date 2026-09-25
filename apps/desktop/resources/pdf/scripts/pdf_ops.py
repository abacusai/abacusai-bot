#!/usr/bin/env python3
"""PDF operations for the pdf component.

The component shells out to this rather than reimplementing PDF parsing in the
main process: the Python ecosystem for PDFs is genuinely good, and none of it
has a JavaScript equivalent worth the trade.

Every subcommand prints one JSON object to stdout on success and on failure, so the
caller never has to parse prose. A missing library is reported as data too,
naming the pip package, because "ModuleNotFoundError: pdfplumber" on stderr is
an error the agent has to guess its way out of.

Subcommands:
  info    <pdf>                      page count, metadata, whether text is extractable
  read    <pdf> [--pages 1-3,7]      text per page
  tables  <pdf> [--pages 1-3]        tables as rows, per page
  merge   <out> <pdf> <pdf> [...]    concatenate
  split   <pdf> <outdir> [--ranges 1-3,4-9]   write one PDF per range
  rotate  <pdf> <out> --degrees 90 [--pages 1-3]
  stamp   <pdf> <out> --text "DRAFT" [--opacity 0.12]
  forms   <pdf>                      list AcroForm fields
  fill    <pdf> <out> --data '{"field": "value"}'
"""
import argparse
import json
import sys


def fail(message, package=None, code='error'):
    out = {'ok': False, 'error': message, 'code': code}
    if package:
        out['install'] = f'pip install {package}'
    print(json.dumps(out))
    sys.exit(0)  # The failure is the payload; a non-zero exit adds nothing.


def need(module, package):
    try:
        return __import__(module)
    except ImportError:
        fail(f'{module} is not installed', package, code='missing-dependency')


def parse_pages(spec, total):
    """`1-3,7` → [0,1,2,6], clamped to the document and 1-based on the way in."""
    if not spec:
        return list(range(total))
    pages = []
    for part in spec.split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            start, _, end = part.partition('-')
            try:
                lo, hi = int(start), int(end)
            except ValueError:
                fail(f'bad page range: {part}')
            pages.extend(range(lo - 1, hi))
        else:
            try:
                pages.append(int(part) - 1)
            except ValueError:
                fail(f'bad page number: {part}')
    return [p for p in pages if 0 <= p < total]


def cmd_info(args):
    pypdf = need('pypdf', 'pypdf')
    reader = pypdf.PdfReader(args.pdf)
    first = reader.pages[0].extract_text() if reader.pages else ''
    meta = {k.lstrip('/'): str(v) for k, v in (reader.metadata or {}).items()}
    print(json.dumps({
        'ok': True,
        'pages': len(reader.pages),
        'encrypted': reader.is_encrypted,
        'metadata': meta,
        # A scanned PDF parses fine and yields no text: the caller needs to know
        # that before it reports an empty document as an empty document.
        'text_extractable': bool((first or '').strip()),
        'hint': None if (first or '').strip() else 'No text on page 1. It is likely scanned and needs OCR.',
    }))


def cmd_read(args):
    pypdf = need('pypdf', 'pypdf')
    reader = pypdf.PdfReader(args.pdf)
    wanted = parse_pages(args.pages, len(reader.pages))
    pages = [{'page': i + 1, 'text': (reader.pages[i].extract_text() or '')} for i in wanted]
    print(json.dumps({
        'ok': True,
        'pages': pages,
        'characters': sum(len(p['text']) for p in pages),
    }))


def cmd_tables(args):
    pdfplumber = need('pdfplumber', 'pdfplumber')
    out = []
    with pdfplumber.open(args.pdf) as pdf:
        for index in parse_pages(args.pages, len(pdf.pages)):
            for table in pdf.pages[index].extract_tables() or []:
                out.append({'page': index + 1, 'rows': table})
    print(json.dumps({'ok': True, 'tables': out, 'count': len(out)}))


def cmd_merge(args):
    pypdf = need('pypdf', 'pypdf')
    writer = pypdf.PdfWriter()
    for source in args.inputs:
        for page in pypdf.PdfReader(source).pages:
            writer.add_page(page)
    with open(args.out, 'wb') as handle:
        writer.write(handle)
    print(json.dumps({'ok': True, 'output': args.out, 'pages': len(writer.pages)}))


def cmd_split(args):
    import os
    pypdf = need('pypdf', 'pypdf')
    reader = pypdf.PdfReader(args.pdf)
    os.makedirs(args.outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(args.pdf))[0]

    ranges = args.ranges.split(',') if args.ranges else [str(i + 1) for i in range(len(reader.pages))]
    written = []
    for spec in ranges:
        writer = pypdf.PdfWriter()
        for index in parse_pages(spec, len(reader.pages)):
            writer.add_page(reader.pages[index])
        if not writer.pages:
            continue
        path = os.path.join(args.outdir, f'{base}-{spec.strip().replace("-", "to")}.pdf')
        with open(path, 'wb') as handle:
            writer.write(handle)
        written.append({'path': path, 'pages': len(writer.pages)})
    print(json.dumps({'ok': True, 'files': written}))


def cmd_rotate(args):
    pypdf = need('pypdf', 'pypdf')
    reader = pypdf.PdfReader(args.pdf)
    writer = pypdf.PdfWriter()
    wanted = set(parse_pages(args.pages, len(reader.pages)))
    for index, page in enumerate(reader.pages):
        if index in wanted:
            page.rotate(args.degrees)
        writer.add_page(page)
    with open(args.out, 'wb') as handle:
        writer.write(handle)
    print(json.dumps({'ok': True, 'output': args.out, 'rotated': len(wanted)}))


def cmd_stamp(args):
    pypdf = need('pypdf', 'pypdf')
    reportlab = need('reportlab', 'reportlab')
    from reportlab.pdfgen import canvas
    import io

    reader = pypdf.PdfReader(args.pdf)
    writer = pypdf.PdfWriter()
    for page in reader.pages:
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        buffer = io.BytesIO()
        pdf = canvas.Canvas(buffer, pagesize=(width, height))
        pdf.saveState()
        pdf.setFillColorRGB(0, 0, 0, alpha=args.opacity)
        pdf.setFont('Helvetica-Bold', min(width, height) / 6)
        pdf.translate(width / 2, height / 2)
        pdf.rotate(38)
        pdf.drawCentredString(0, 0, args.text)
        pdf.restoreState()
        pdf.save()
        buffer.seek(0)
        page.merge_page(pypdf.PdfReader(buffer).pages[0])
        writer.add_page(page)
    with open(args.out, 'wb') as handle:
        writer.write(handle)
    print(json.dumps({'ok': True, 'output': args.out, 'pages': len(writer.pages)}))


def cmd_forms(args):
    pypdf = need('pypdf', 'pypdf')
    reader = pypdf.PdfReader(args.pdf)
    fields = reader.get_fields() or {}
    described = [
        {
            'name': name,
            'type': str(field.get('/FT', '')).lstrip('/'),
            'value': str(field.get('/V', '')),
        }
        for name, field in fields.items()
    ]
    print(json.dumps({'ok': True, 'fields': described, 'count': len(described)}))


def cmd_fill(args):
    pypdf = need('pypdf', 'pypdf')
    try:
        data = json.loads(args.data)
    except json.JSONDecodeError as exc:
        fail(f'--data is not valid JSON: {exc}')

    reader = pypdf.PdfReader(args.pdf)
    writer = pypdf.PdfWriter()
    writer.append(reader)
    for page in writer.pages:
        writer.update_page_form_field_values(page, data)
    with open(args.out, 'wb') as handle:
        writer.write(handle)
    print(json.dumps({'ok': True, 'output': args.out, 'filled': list(data)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)

    p = sub.add_parser('info'); p.add_argument('pdf'); p.set_defaults(fn=cmd_info)

    p = sub.add_parser('read'); p.add_argument('pdf'); p.add_argument('--pages'); p.set_defaults(fn=cmd_read)

    p = sub.add_parser('tables'); p.add_argument('pdf'); p.add_argument('--pages'); p.set_defaults(fn=cmd_tables)

    p = sub.add_parser('merge'); p.add_argument('out'); p.add_argument('inputs', nargs='+'); p.set_defaults(fn=cmd_merge)

    p = sub.add_parser('split'); p.add_argument('pdf'); p.add_argument('outdir')
    p.add_argument('--ranges'); p.set_defaults(fn=cmd_split)

    p = sub.add_parser('rotate'); p.add_argument('pdf'); p.add_argument('out')
    p.add_argument('--degrees', type=int, default=90); p.add_argument('--pages'); p.set_defaults(fn=cmd_rotate)

    p = sub.add_parser('stamp'); p.add_argument('pdf'); p.add_argument('out')
    p.add_argument('--text', required=True); p.add_argument('--opacity', type=float, default=0.12)
    p.set_defaults(fn=cmd_stamp)

    p = sub.add_parser('forms'); p.add_argument('pdf'); p.set_defaults(fn=cmd_forms)

    p = sub.add_parser('fill'); p.add_argument('pdf'); p.add_argument('out')
    p.add_argument('--data', required=True); p.set_defaults(fn=cmd_fill)

    args = parser.parse_args()
    try:
        args.fn(args)
    except FileNotFoundError as exc:
        fail(f'file not found: {exc.filename}', code='not-found')
    # The caller wants the message, not a traceback.
    except Exception as exc:  # noqa: BLE001
        fail(f'{type(exc).__name__}: {exc}')


if __name__ == '__main__':
    main()
