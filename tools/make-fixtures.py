"""Generate demo fixtures: a two-column Indian-style lab report PDF, a scanned-style (image-only) PDF,
and a synthetic 16-bit MONOCHROME2 DICOM. Fictional patient; no real data."""
import struct, sys, os, math
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(OUT, exist_ok=True)

# (name, value, flag, unit, range) — first page two-column (CBC left, lipid right), second page single column.
CBC = [
    ('Haemoglobin (Hb)', '12.1', 'L', 'g/dL', '13.0 - 17.0'),
    ('Total Leucocyte Count (TLC)', '7,800', '', 'cells/cumm', '4000 - 11000'),
    ('RBC Count', '4.62', '', 'mill/cumm', '4.5 - 5.5'),
    ('PCV', '39.8', 'L', '%', '40 - 50'),
    ('MCV', '86.1', '', 'fL', '83 - 101'),
    ('MCH', '26.2', 'L', 'pg', '27 - 32'),
    ('MCHC', '30.4', 'L', 'g/dL', '31.5 - 34.5'),
    ('Neutrophils', '62', '', '%', '40 - 80'),
    ('Lymphocytes', '30', '', '%', '20 - 40'),
    ('Platelet Count', '2.45', '', 'lakhs/cumm', '1.5 - 4.1'),
]
LIPID = [
    ('Cholesterol, Total', '214', 'H', 'mg/dL', '< 200'),
    ('Triglycerides', '168', 'H', 'mg/dL', '< 150'),
    ('HDL Cholesterol', '38', 'L', 'mg/dL', '> 40'),
    ('LDL Cholesterol', '142', 'H', 'mg/dL', '< 100'),
    ('VLDL Cholesterol', '34', 'H', 'mg/dL', '< 30'),
    ('Non-HDL Cholesterol', '176', 'H', 'mg/dL', '< 130'),
    ('Chol/HDL Ratio', '5.6', 'H', '', '3.5 - 5.0'),
]
LIVER = [
    ('Bilirubin Total', '0.82', '', 'mg/dL', '0.3 - 1.2'),
    ('Bilirubin Direct', '0.21', '', 'mg/dL', '0.0 - 0.3'),
    ('SGOT (AST)', '32', '', 'U/L', '< 35'),
    ('SGPT (ALT)', '48', 'H', 'U/L', 'Upto 40'),
    ('Alkaline Phosphatase', '88', '', 'U/L', '30 - 120'),
    ('Albumin', '4.3', '', 'g/dL', '3.5 - 5.2'),
]
THYROID = [
    ('T3, Total', '1.12', '', 'ng/mL', '0.8 - 2.0'),
    ('T4, Total', '8.4', '', 'µg/dL', '5.1 - 14.1'),
    ('TSH (Ultrasensitive)', '4.82', 'H', 'µIU/mL', '0.27 - 4.20'),
]

def header(c, page):
    W, H = A4
    c.setFont('Helvetica-Bold', 15)
    c.drawString(40, H - 50, 'LOTUS DIAGNOSTICS PVT. LTD.')
    c.setFont('Helvetica', 8)
    c.drawString(40, H - 62, 'Plot 12, Example Road, Hyderabad 500001 | Ph: 040-0000000 | www.example.invalid')
    c.setFont('Helvetica', 9)
    c.drawString(40, H - 90, 'Patient Name : Ms. ASHA DEMO')
    c.drawString(330, H - 90, 'Lab No. : LD2610281234')
    c.drawString(40, H - 103, 'Age / Sex : 34 Y / Female')
    c.drawString(330, H - 103, 'Collected On : 28/Oct/2026 08:12 AM')
    c.drawString(40, H - 116, 'Ref. By : Dr. Self')
    c.drawString(330, H - 116, 'Reported On : 29/Oct/2026 06:40 PM')
    c.drawString(40, H - 129, 'Date of Birth : 12/03/1992')
    c.drawString(330, H - 129, f'Page {page} of 2')
    c.line(40, H - 137, W - 40, H - 137)

def table(c, x, y, title, rows, cols):
    c.setFont('Helvetica-Bold', 10)
    c.drawString(x, y, title)
    y -= 15
    c.setFont('Helvetica-Bold', 8)
    for label, dx in zip(['Test Name', 'Result', 'Unit', 'Bio. Ref. Interval'], cols):
        c.drawString(x + dx, y, label)
    y -= 4
    c.line(x, y, x + cols[3] + 70, y)
    y -= 12
    c.setFont('Helvetica', 8)
    for name, val, flag, unit, rng in rows:
        c.drawString(x + cols[0], y, name)
        if flag:
            c.setFont('Helvetica-Bold', 8)
            c.drawString(x + cols[1], y, f'{val} {flag}')
            c.setFont('Helvetica', 8)
        else:
            c.drawString(x + cols[1], y, val)
        c.drawString(x + cols[2], y, unit)
        c.drawString(x + cols[3], y, rng)
        y -= 14
    return y

def make_pdf():
    path = os.path.join(OUT, 'sample-lab-report.pdf')
    c = canvas.Canvas(path, pagesize=A4)
    W, H = A4
    header(c, 1)
    c.setFont('Helvetica-Bold', 11)
    c.drawCentredString(W / 2, H - 155, 'DEPARTMENT OF HAEMATOLOGY & BIOCHEMISTRY')
    cols = [0, 112, 148, 192]
    yl = table(c, 40, H - 180, 'COMPLETE BLOOD COUNT (CBC)', CBC, cols)
    yr = table(c, 305, H - 180, 'LIPID PROFILE', LIPID, cols)
    y = min(yl, yr) - 10
    c.setFont('Helvetica-Oblique', 7)
    c.drawString(40, y, 'Method: Automated cell counter / Enzymatic colorimetric. Sample type: EDTA whole blood, Serum.')
    c.drawString(40, y - 10, 'Note: LDL cholesterol is calculated using the Friedewald formula when triglycerides are below 400 mg/dL.')
    c.drawString(40, y - 20, 'Interpretation: Desirable cholesterol < 200 mg/dL, borderline 200 - 239 mg/dL, high >= 240 mg/dL.')
    c.setFont('Helvetica', 8)
    c.drawString(40, 60, 'This is a computer generated report. Dr. A. Example, MD (Pathology)')
    c.showPage()

    header(c, 2)
    cols = [0, 170, 220, 290]
    y = table(c, 40, H - 165, 'LIVER FUNCTION TEST (LFT)', LIVER, cols)
    y = table(c, 40, y - 14, 'THYROID PROFILE, TOTAL', THYROID, cols)
    c.setFont('Helvetica-Oblique', 7)
    c.drawString(40, y - 6, 'Method: CLIA. Kindly correlate clinically.')
    c.setFont('Helvetica', 8)
    c.drawCentredString(W / 2, 80, '*** End of Report ***')
    c.showPage()
    c.save()
    return path

def make_image_pdf():
    """PDF with only vector graphics and no text layer (stands in for a scanned report)."""
    path = os.path.join(OUT, 'scanned-report-no-text.pdf')
    c = canvas.Canvas(path, pagesize=A4)
    W, H = A4
    for i in range(30):
        c.rect(40, H - 80 - i * 22, W - 80, 14, stroke=1, fill=0)
    c.showPage()
    c.save()
    return path

# ---------------- DICOM ----------------
def el_explicit(group, elem, vr, value):
    if isinstance(value, str):
        b = value.encode('ascii')
        if len(b) % 2:
            b += b'\0' if vr == 'UI' else b' '
    else:
        b = value
    if vr in ('OB', 'OW', 'SQ', 'UN', 'UT'):
        return struct.pack('<HH2sHI', group, elem, vr.encode(), 0, len(b)) + b
    return struct.pack('<HH2sH', group, elem, vr.encode(), len(b)) + b

def make_dicom(path, rows=64, cols=80, photometric='MONOCHROME2', signed=False, intercept=None, slope=None, wc=None, ww=None, body='CHEST', modality='CR', date='20261028', study='CHEST PA VIEW', ts='1.2.840.10008.1.2.1'):
    px = bytearray()
    for r in range(rows):
        for c_ in range(cols):
            # Gradient + bright disc: values 0..4095 (12 bits stored in 16).
            dx, dy = c_ - cols / 2, r - rows / 2
            v = int(4095 * (c_ / (cols - 1)) * 0.6)
            if dx * dx + dy * dy < (min(rows, cols) / 4) ** 2:
                v = 4000
            if signed:
                v -= 1024
                px += struct.pack('<h', v)
            else:
                px += struct.pack('<H', v)
    sop_class = '1.2.840.10008.5.1.4.1.1.1'
    sop_inst = '1.2.826.0.1.3680043.10.999.1.1'
    meta_body = (el_explicit(0x0002, 0x0001, 'OB', b'\x00\x01') +
                 el_explicit(0x0002, 0x0002, 'UI', sop_class) +
                 el_explicit(0x0002, 0x0003, 'UI', sop_inst) +
                 el_explicit(0x0002, 0x0010, 'UI', ts) +
                 el_explicit(0x0002, 0x0012, 'UI', '1.2.826.0.1.3680043.10.999'))
    meta = el_explicit(0x0002, 0x0000, 'UL', struct.pack('<I', len(meta_body))) + meta_body
    ds = b''
    ds += el_explicit(0x0008, 0x0016, 'UI', sop_class)
    ds += el_explicit(0x0008, 0x0018, 'UI', sop_inst)
    ds += el_explicit(0x0008, 0x0020, 'DA', date)
    ds += el_explicit(0x0008, 0x0060, 'CS', modality)
    ds += el_explicit(0x0008, 0x1030, 'LO', study)
    ds += el_explicit(0x0010, 0x0010, 'PN', 'DEMO^ASHA')
    ds += el_explicit(0x0018, 0x0015, 'CS', body)
    ds += el_explicit(0x0028, 0x0002, 'US', struct.pack('<H', 1))
    ds += el_explicit(0x0028, 0x0004, 'CS', photometric)
    ds += el_explicit(0x0028, 0x0010, 'US', struct.pack('<H', rows))
    ds += el_explicit(0x0028, 0x0011, 'US', struct.pack('<H', cols))
    ds += el_explicit(0x0028, 0x0100, 'US', struct.pack('<H', 16))
    ds += el_explicit(0x0028, 0x0101, 'US', struct.pack('<H', 12 if not signed else 16))
    ds += el_explicit(0x0028, 0x0102, 'US', struct.pack('<H', 11 if not signed else 15))
    ds += el_explicit(0x0028, 0x0103, 'US', struct.pack('<H', 1 if signed else 0))
    if wc is not None:
        ds += el_explicit(0x0028, 0x1050, 'DS', str(wc))
        ds += el_explicit(0x0028, 0x1051, 'DS', str(ww))
    if intercept is not None:
        ds += el_explicit(0x0028, 0x1052, 'DS', str(intercept))
        ds += el_explicit(0x0028, 0x1053, 'DS', str(slope))
    ds += el_explicit(0x7fe0, 0x0010, 'OW', bytes(px))
    with open(path, 'wb') as f:
        f.write(b'\0' * 128 + b'DICM' + meta + ds)
    return path

def draw_words(c, x, y, text, font='Helvetica', size=8):
    """Draw each word as a separate text item (like many real PDFs), so pdf.js returns split items."""
    c.setFont(font, size)
    cx = x
    for w in text.split(' '):
        c.drawString(cx, y, w)
        cx += c.stringWidth(w + ' ', font, size)

def make_pdf_hard():
    """Thyrocare/Apollo-like layout: method column, separate flag column, per-word items,
    multi-line reference ranges, urine section, repeated header on page 2."""
    path = os.path.join(OUT, 'lab-report-method-column.pdf')
    c = canvas.Canvas(path, pagesize=A4)
    W, H = A4
    cols = [40, 190, 300, 335, 390, 450]  # name, method, value, flag, unit, range
    def head(y):
        c.setFont('Helvetica-Bold', 8)
        for t, x in zip(['TEST NAME', 'TECHNOLOGY', 'VALUE', '', 'UNITS', 'REFERENCE RANGE'], cols):
            if t: c.drawString(x, y, t)
        c.line(40, y - 4, W - 40, y - 4)
    c.setFont('Helvetica-Bold', 13)
    c.drawString(40, H - 45, 'EXAMPLE PATHLABS')
    c.setFont('Helvetica', 8)
    c.drawString(40, H - 70, 'NAME : RAVI DEMO (41Y/M)      REF. BY : SELF      TEST ASKED : AAROGYAM')
    c.drawString(40, H - 82, 'SAMPLE COLLECTED AT : HOME       Sample Collected on (SCT) : 16 Jul 2026 07:45')
    c.drawString(40, H - 94, 'Report Released on (RRT) : 17 Jul 2026 13:02')
    head(H - 120)
    y = H - 138
    rows = [
        ('25-OH VITAMIN D (TOTAL)', 'C.L.I.A', '18.4', 'L', 'ng/mL', ['Deficiency : <20', 'Insufficiency : 20-<30', 'Sufficiency : 30-100']),
        ('VITAMIN B-12', 'C.L.I.A', '182', 'L', 'pg/mL', ['211 - 911']),
        ('HbA1c', 'H.P.L.C', '6.1', 'H', '%', ['Non-diabetic : < 5.7', 'Pre-diabetic : 5.7 - 6.4', 'Diabetic : >= 6.5']),
        ('AVERAGE BLOOD GLUCOSE (ABG)', 'CALCULATED', '128', '', 'mg/dL', ['90 - 120']),
        ('FASTING BLOOD SUGAR (GLUCOSE)', 'HEXOKINASE', '104', 'H', 'mg/dL', ['70 - 100']),
        ('IRON', 'PHOTOMETRY', '62', '', 'µg/dL', ['65 - 175']),
        ('TOTAL IRON BINDING CAPACITY (TIBC)', 'PHOTOMETRY', '402', '', 'µg/dL', ['225 - 535']),
        ('% TRANSFERRIN SATURATION', 'CALCULATED', '15.4', 'L', '%', ['13 - 45']),
        ('SERUM FERRITIN', 'C.L.I.A', '21.3', '', 'ng/mL', ['22 - 322']),
        ('CREATININE - SERUM', 'PHOTOMETRY', '0.94', '', 'mg/dL', ['0.6 - 1.1']),
        ('URIC ACID', 'PHOTOMETRY', '7.6', 'H', 'mg/dL', ['3.5 - 7.2']),
        ('EST. GLOMERULAR FILTRATION RATE (eGFR)', 'CALCULATED', '98', '', 'mL/min/1.73 m2', ['>= 90']),
        ('SODIUM', 'I.S.E - INDIRECT', '139', '', 'mmol/L', ['136 - 145']),
        ('HIGH SENSITIVITY C-REACTIVE PROTEIN (HS-CRP)', 'IMMUNOTURBIDIMETRY', '3.8', 'H', 'mg/L', ['< 1 Low risk', '1 - 3 Average risk', '> 3 High risk']),
    ]
    for name, method, val, flag, unit, rng in rows:
        draw_words(c, cols[0], y, name)
        draw_words(c, cols[1], y, method, size=7)
        c.setFont('Helvetica-Bold' if flag else 'Helvetica', 8)
        c.drawString(cols[2], y, val)
        if flag: c.drawString(cols[3], y, flag)
        c.setFont('Helvetica', 8)
        c.drawString(cols[4], y, unit)
        for k, r in enumerate(rng):
            draw_words(c, cols[5], y - k * 10, r, size=7)
        y -= 14 + 10 * (len(rng) - 1)
    c.setFont('Helvetica-Oblique', 7)
    c.drawString(40, y - 4, 'Please correlate with clinical conditions. Method : Fully automated chemiluminescent immunoassay.')
    c.showPage()

    c.setFont('Helvetica', 8)
    c.drawString(40, H - 45, 'NAME : RAVI DEMO (41Y/M)      Sample Collected on (SCT) : 16 Jul 2026 07:45')
    head(H - 70)
    y = H - 92
    c.setFont('Helvetica-Bold', 9)
    c.drawString(40, y, 'COMPLETE URINE ANALYSIS (CUE)')
    y -= 16
    urine = [('COLOUR', 'VISUAL', 'PALE YELLOW', '', '', 'PALE YELLOW'), ('pH', 'DIPSTICK', '6.0', '', '', '4.6 - 8.0'),
             ('SPECIFIC GRAVITY', 'DIPSTICK', '1.020', '', '', '1.003 - 1.035'), ('PROTEIN', 'DIPSTICK', 'NEGATIVE', '', '', 'NEGATIVE'),
             ('GLUCOSE', 'DIPSTICK', 'NEGATIVE', '', '', 'NEGATIVE'), ('KETONES', 'DIPSTICK', 'NEGATIVE', '', '', 'NEGATIVE'),
             ('PUS CELLS', 'MICROSCOPY', '4-6', 'H', '/hpf', '0 - 5'), ('RED BLOOD CELLS', 'MICROSCOPY', 'NIL', '', '/hpf', '0 - 2'),
             ('NITRITE', 'DIPSTICK', 'NEGATIVE', '', '', 'NEGATIVE')]
    for name, method, val, flag, unit, rng in urine:
        draw_words(c, cols[0], y, name)
        draw_words(c, cols[1], y, method, size=7)
        c.setFont('Helvetica', 8)
        draw_words(c, cols[2], y, val)
        if flag: c.drawString(cols[3], y, flag)
        if unit: c.drawString(cols[4], y, unit)
        draw_words(c, cols[5], y, rng, size=7)
        y -= 14
    c.setFont('Helvetica', 8)
    c.drawCentredString(W / 2, 60, '~~ End of report ~~')
    c.showPage()
    c.save()
    return path

def make_jpeg_dicom(path):
    """JPEG Baseline (encapsulated) 8-bit MONOCHROME2 DICOM; exercises the compressed path."""
    from PIL import Image, ImageDraw
    import io
    img = Image.new('L', (96, 96), 20)
    d = ImageDraw.Draw(img)
    d.ellipse((18, 14, 78, 86), fill=170)
    d.ellipse((34, 30, 62, 70), fill=90)
    buf = io.BytesIO(); img.save(buf, 'JPEG', quality=90); jpg = buf.getvalue()
    if len(jpg) % 2: jpg += b'\0'
    ts = '1.2.840.10008.1.2.4.50'
    sop_class = '1.2.840.10008.5.1.4.1.1.4'
    meta_body = (el_explicit(0x0002, 0x0001, 'OB', b'\x00\x01') + el_explicit(0x0002, 0x0002, 'UI', sop_class) +
                 el_explicit(0x0002, 0x0003, 'UI', '1.2.826.0.1.3680043.10.999.1.3') + el_explicit(0x0002, 0x0010, 'UI', ts))
    meta = el_explicit(0x0002, 0x0000, 'UL', struct.pack('<I', len(meta_body))) + meta_body
    ds = (el_explicit(0x0008, 0x0020, 'DA', '20260314') + el_explicit(0x0008, 0x0060, 'CS', 'MR') +
          el_explicit(0x0008, 0x1030, 'LO', 'MRI BRAIN PLAIN') + el_explicit(0x0018, 0x0015, 'CS', 'HEAD') +
          el_explicit(0x0028, 0x0002, 'US', struct.pack('<H', 1)) + el_explicit(0x0028, 0x0004, 'CS', 'MONOCHROME2') +
          el_explicit(0x0028, 0x0010, 'US', struct.pack('<H', 96)) + el_explicit(0x0028, 0x0011, 'US', struct.pack('<H', 96)) +
          el_explicit(0x0028, 0x0100, 'US', struct.pack('<H', 8)) + el_explicit(0x0028, 0x0101, 'US', struct.pack('<H', 8)) +
          el_explicit(0x0028, 0x0102, 'US', struct.pack('<H', 7)) + el_explicit(0x0028, 0x0103, 'US', struct.pack('<H', 0)))
    # Encapsulated pixel data: undefined length, empty basic offset table item, one fragment, sequence delimiter.
    px = struct.pack('<HH2sHI', 0x7fe0, 0x0010, b'OB', 0, 0xffffffff)
    px += struct.pack('<HHI', 0xfffe, 0xe000, 0)
    px += struct.pack('<HHI', 0xfffe, 0xe000, len(jpg)) + jpg
    px += struct.pack('<HHI', 0xfffe, 0xe0dd, 0)
    with open(path, 'wb') as f:
        f.write(b'\0' * 128 + b'DICM' + meta + ds + px)
    return path

def make_tabular():
    csv_path = os.path.join(OUT, 'results-export.csv')
    with open(csv_path, 'w', encoding='utf-8') as f:
        f.write('Test,Result,Unit,Reference Range,Collected On\n')
        for date, tc, ldl, hdl, tg, a1c, tsh, vd in [('14/03/2026', 212, 138, 38, 168, 5.6, 4.6, 14.2), ('02/07/2026', 198, 121, 42, 141, 5.6, 4.3, 22.5), ('20/10/2026', 189, 112, 47, 128, 5.5, 3.9, 31.4)]:
            f.write(f'Total Cholesterol,{tc},mg/dL,< 200,{date}\nLDL Cholesterol,{ldl},mg/dL,< 100,{date}\nHDL Cholesterol,{hdl},mg/dL,> 40,{date}\n')
            f.write(f'Triglycerides,{tg},mg/dL,< 150,{date}\nHbA1c,{a1c},%,< 5.7,{date}\nTSH,{tsh},mIU/L,0.4 - 4.5,{date}\n25-OH Vitamin D,{vd},ng/mL,30 - 100,{date}\n')
    json_path = os.path.join(OUT, 'results-export.json')
    import json
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({'date': '2026-10-20', 'results': [
            {'name': 'Hemoglobin', 'value': 12.9, 'unit': 'g/dL', 'range': '12.0 - 15.5'},
            {'name': 'Platelet Count', 'value': '2.6', 'unit': 'lakhs/cumm', 'range': '1.5 - 4.1'},
            {'name': 'SGPT (ALT)', 'value': '33', 'unit': 'U/L', 'range': 'Upto 40'},
            {'name': 'Ferritin', 'value': '28', 'unit': 'ng/mL', 'range': '15 - 150'},
            {'name': 'Glucose Fasting', 'value': '5.1', 'unit': 'mmol/L', 'range': '3.9 - 5.6'},
        ]}, f, indent=2)
    return csv_path, json_path

if __name__ == '__main__':
    print(make_pdf_hard())
    print(make_jpeg_dicom(os.path.join(OUT, 'mri-brain-jpeg-synthetic.dcm')))
    print(*make_tabular(), sep='\n')
    print(make_pdf())
    print(make_image_pdf())
    print(make_dicom(os.path.join(OUT, 'chest-xray-synthetic.dcm'), wc=2048, ww=4096))
    print(make_dicom(os.path.join(OUT, 'ct-abdomen-synthetic.dcm'), rows=48, cols=48, signed=True, intercept=-1024, slope=1,
                     wc=40, ww=400, body='ABDOMEN', modality='CT', date='20260702', study='CT ABDOMEN', photometric='MONOCHROME2'))
