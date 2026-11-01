#!/usr/bin/env python3
"""Inspect PPTX editability indicators without executing or extracting archive contents."""
import argparse
import json
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


def check(path, expected):
    blockers = []
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if sum(item.file_size for item in infos) > 50_000_000 or len(infos) > 10000:
            raise ValueError('Archive exceeds inspection budget')
        names = [item.filename for item in infos]
        slides = [name for name in names if name.startswith('ppt/slides/slide') and name.endswith('.xml')]
        charts = [name for name in names if name.startswith('ppt/charts/chart') and name.endswith('.xml')]
        workbooks = [name for name in names if name.startswith('ppt/embeddings/') and name.endswith('.xlsx')]
        shapes = connectors = pictures = chart_links = 0
        for name in slides:
            raw = archive.read(name)
            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
                raise ValueError('DTD/entities not accepted')
            tree = ET.fromstring(raw)
            shapes += len(tree.findall('.//{http://schemas.openxmlformats.org/presentationml/2006/main}sp'))
            connectors += len(tree.findall('.//{http://schemas.openxmlformats.org/presentationml/2006/main}cxnSp'))
            pictures += len(tree.findall('.//{http://schemas.openxmlformats.org/presentationml/2006/main}pic'))
            chart_links += len(tree.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/chart}chart'))
        if not slides:
            blockers.append('No slide parts')
        if expected == 'chart' and not (charts and workbooks and chart_links):
            blockers.append('Native chart, chart reference and embedded data workbook are required; a picture is insufficient')
        if expected == 'diagram' and not (shapes >= 2 and connectors >= 1):
            blockers.append('Native shapes and connectors required for a diagram')
    return {'version': 1, 'status': 'blocked' if blockers else 'passed', 'blockers': blockers, 'slides': len(slides),
            'nativeCharts': len(charts), 'embeddedWorkbooks': len(workbooks), 'shapes': shapes, 'connectors': connectors,
            'pictures': pictures, 'limits': 'Structural indicators only; rendering, full OOXML validity and actual PowerPoint editing require separate QA.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input')
    p.add_argument('--expect', choices=['chart', 'diagram'], required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    if Path(args.input).resolve() == Path(args.out).resolve():
        p.error('Output must not overwrite presentation')
    report = check(args.input, args.expect)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(report['status'])
    return bool(report['blockers'])


if __name__ == '__main__':
    raise SystemExit(main())
