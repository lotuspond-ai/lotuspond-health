#!/usr/bin/env python3
"""Synthetic photographed lab reports for the OCR tests (tools/test-ocr.ts).

Five layouts in the styles common to Indian lab reports, with made-up patients and a made-up lab name; each is
"photographed" (slight tilt, blur, uneven light, sensor noise, JPEG). The values each one prints are written to
report-photos.json (in the catalogue's units: 7800 cells/cumm is 7.8 × 10^3/µL, 1.12 ng/mL of T3 is 112 ng/dL),
which the tests use as the truth when measuring how many results the reader gets right.

    python3 tools/fixtures/make-report-photos.py   # needs Pillow and the DejaVu / Liberation fonts
"""
import json
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'report-photos')
SANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
BOLD = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

W, H = 1240, 1754  # A4 at 150 dpi

LAYOUTS = [
    {
        'file': 'cbc-bio-ref-interval.jpg',
        'title': 'COMPLETE BLOOD COUNT (CBC)',
        'header': ['Test Name', 'Result', 'Unit', 'Bio. Ref. Interval'],
        'font': SANS,
        'rows': [
            ('Haemoglobin', '13.2', 'g/dL', '13.0 - 17.0'),
            ('Total Leucocyte Count', '7800', 'cells/cumm', '4000 - 11000'),
            ('Platelet Count', '2.4', 'lakhs/cumm', '1.5 - 4.1'),
            ('RBC Count', '4.62', 'million/cumm', '4.5 - 5.5'),
            ('PCV', '41.5', '%', '40 - 50'),
            ('MCV', '89.8', 'fL', '83 - 101'),
            ('MCH', '28.6', 'pg', '27 - 32'),
            ('MCHC', '31.8', 'g/dL', '31.5 - 34.5'),
        ],
        'truth': {'hemoglobin': 13.2, 'wbc': 7.8, 'rbc': 4.62, 'hematocrit': 41.5, 'mcv': 89.8, 'mch': 28.6, 'mchc': 31.8},
    },
    {
        'file': 'lipid-observed-value-flags.jpg',
        'title': 'LIPID PROFILE',
        'header': ['Investigation', 'Observed Value', 'Unit', 'Reference Range'],
        'font': DEJAVU,
        'rows': [
            ('Total Cholesterol', '226 H', 'mg/dL', '< 200'),
            ('Triglycerides', '182 H', 'mg/dL', '< 150'),
            ('HDL Cholesterol', '38 L', 'mg/dL', '> 40'),
            ('LDL Cholesterol', '151 H', 'mg/dL', '< 100'),
            ('VLDL Cholesterol', '36.4', 'mg/dL', '< 30'),
        ],
        'truth': {'total_cholesterol': 226, 'triglycerides': 182, 'hdl': 38, 'ldl': 151},
    },
    {
        'file': 'thyroid-with-method.jpg',
        'title': 'THYROID PROFILE',
        'header': ['TEST', 'VALUE', 'UNITS', 'REFERENCE RANGE'],
        'font': SANS,
        'method': 'Method: CLIA',
        'rows': [
            ('TOTAL T3', '1.12', 'ng/mL', '0.60 - 1.81'),
            ('TOTAL T4', '8.4', 'ug/dL', '5.01 - 12.45'),
            ('TSH', '5.86', 'uIU/mL', '0.35 - 4.94'),
        ],
        'truth': {'t3': 112, 't4': 8.4, 'tsh': 5.86},
    },
    {
        'file': 'kidney-liver-summary.jpg',
        'title': 'KIDNEY AND LIVER FUNCTION',
        'header': ['Parameter', 'Result', 'Units', 'Normal Range'],
        'font': DEJAVU,
        'rows': [
            ('Serum Creatinine', '0.92', 'mg/dL', '0.70 - 1.30'),
            ('Blood Urea', '28', 'mg/dL', '17 - 43'),
            ('Uric Acid', '6.8', 'mg/dL', '3.5 - 7.2'),
            ('SGPT (ALT)', '48', 'U/L', '< 45'),
            ('SGOT (AST)', '36', 'U/L', '< 35'),
            ('Bilirubin Total', '0.8', 'mg/dL', '0.3 - 1.2'),
        ],
        'truth': {'creatinine': 0.92, 'urea': 28, 'uric_acid': 6.8, 'alt': 48, 'ast': 36, 'bilirubin_total': 0.8},
    },
    {
        'file': 'diabetes-vitamins-shaded.jpg',
        'title': 'DIABETES AND VITAMIN PANEL',
        'header': ['Test Description', 'Result', 'Unit', 'Biological Reference'],
        'font': SANS,
        'shaded': True,
        'rows': [
            ('Glucose Fasting', '118', 'mg/dL', '70 - 100'),
            ('HbA1c', '6.4', '%', '4.0 - 5.6'),
            ('Vitamin D (25-OH)', '18.6', 'ng/mL', '30 - 100'),
            ('Vitamin B12', '312', 'pg/mL', '211 - 911'),
        ],
        'truth': {'glucose_fasting': 118, 'hba1c': 6.4, 'vitamin_d': 18.6, 'vitamin_b12': 312},
    },
]


def page(layout):
    img = Image.new('L', (W, H), 248)
    d = ImageDraw.Draw(img)
    f = lambda size, bold=False: ImageFont.truetype(BOLD if bold else layout['font'], size)
    d.text((80, 70), 'SAMPLE DIAGNOSTICS (synthetic test report)', font=f(34, True), fill=20)
    d.text((80, 120), 'NABL Accredited Laboratory  |  Not a real report', font=f(20), fill=60)
    d.line((80, 160, W - 80, 160), fill=90, width=2)
    for i, (k, v) in enumerate([('Patient Name', 'Test Patient'), ('Age / Sex', '41 Y / F'),
                                 ('Sample Collected', '04/11/2026 08:15'), ('Reported', '04/11/2026 18:40')]):
        x = 80 + (i % 2) * 560
        y = 185 + (i // 2) * 40
        d.text((x, y), f'{k}: {v}', font=f(24), fill=30)
    d.text((80, 300), layout['title'], font=f(30, True), fill=15)
    cols = [80, 560, 760, 950]
    y = 360
    for c, h in zip(cols, layout['header']):
        d.text((c, y), h, font=f(24, True), fill=20)
    d.line((80, y + 38, W - 80, y + 38), fill=120, width=1)
    y += 60
    for i, row in enumerate(layout['rows']):
        if layout.get('shaded') and i % 2 == 0:
            d.rectangle((70, y - 8, W - 70, y + 38), fill=228)
        for c, cell in zip(cols, row):
            d.text((c, y), cell, font=f(24, c == cols[1] and (' H' in cell or ' L' in cell)), fill=25)
        y += 52
        if layout.get('method'):
            d.text((cols[0] + 10, y - 10), layout['method'], font=f(18), fill=90)
            y += 30
    d.text((80, H - 160), '*** End of Report ***', font=f(22), fill=80)
    return img


def photograph(img, seed):
    rnd = random.Random(seed)
    img = img.rotate(rnd.uniform(-1.8, 1.8), resample=Image.BICUBIC, expand=False, fillcolor=200)
    # Uneven light: a soft gradient from one corner.
    grad = Image.linear_gradient('L').resize(img.size).rotate(rnd.choice([0, 90, 180, 270]))
    img = Image.blend(img, Image.eval(grad, lambda v: 200 + v // 5), 0.18)
    img = img.filter(ImageFilter.GaussianBlur(rnd.uniform(0.6, 1.0)))
    px = img.load()
    for _ in range(W * H // 40):
        x, y = rnd.randrange(W), rnd.randrange(H)
        px[x, y] = max(0, min(255, px[x, y] + rnd.randint(-40, 40)))
    return img.convert('RGB')


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    for i, layout in enumerate(LAYOUTS):
        photo = photograph(page(layout), seed=1000 + i)
        photo.save(os.path.join(OUT, layout['file']), 'JPEG', quality=72)
        manifest.append({'file': layout['file'], 'layout': ' | '.join(layout['header']), 'truth': layout['truth']})
    # A scanned PDF: the lipid photo as an image-only page (no text layer), as a phone scanner app saves it.
    Image.open(os.path.join(OUT, LAYOUTS[1]['file'])).save(os.path.join(OUT, 'scanned-lipid.pdf'), 'PDF', resolution=150)
    with open(os.path.join(HERE, 'report-photos.json'), 'w') as fh:
        json.dump({'note': 'Synthetic, made-up reports; see make-report-photos.py.', 'reports': manifest}, fh, indent=1)
        fh.write('\n')


if __name__ == '__main__':
    main()
