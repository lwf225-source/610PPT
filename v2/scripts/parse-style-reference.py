#!/usr/bin/env python3
"""Render reference inputs only; never compose generated presentation pages."""
import argparse, json, os, re, shutil, subprocess, tempfile, zipfile, posixpath
from pathlib import Path
from xml.etree import ElementTree as ET
from PIL import Image, ImageOps, ImageDraw

NS = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'p': 'http://schemas.openxmlformats.org/presentationml/2006/main', 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
MAX_PAGES = 30
Image.MAX_IMAGE_PIXELS = 40_000_000

def ppt_metadata(source):
    with zipfile.ZipFile(source) as z:
        infos = z.infolist()
        if len(infos) > 15000 or sum(i.file_size for i in infos) > 400*1024*1024:
            raise ValueError('PPTX 解压后过大，请减少参考页')
        pres = ET.fromstring(z.read('ppt/presentation.xml'))
        rels = {e.get('Id'): e.get('Target') for e in ET.fromstring(z.read('ppt/_rels/presentation.xml.rels'))}
        slide_ids = pres.findall('p:sldIdLst/p:sldId', NS)
        if not 0 < len(slide_ids) <= MAX_PAGES:
            raise ValueError(f'参考 PPTX 需包含 1–{MAX_PAGES} 页，请先保留代表页')
        size = pres.find('p:sldSz', NS)
        themes = []
        for name in sorted(z.namelist()):
            if re.fullmatch(r'ppt/theme/theme\d+\.xml', name):
                theme = ET.fromstring(z.read(name))
                palette = []
                for c in theme.findall('.//a:clrScheme/*', NS):
                    child = next(iter(c), None)
                    if child is not None:
                        palette.append({'name': c.tag.split('}')[-1], 'color': child.get('lastClr') or child.get('val')})
                fonts = [x.get('typeface') for x in theme.findall('.//a:fontScheme//*', NS) if x.get('typeface')]
                themes.append({'palette': palette, 'fonts': list(dict.fromkeys(fonts))[:30]})
        pages = []
        for n, sid in enumerate(slide_ids, 1):
            target = rels[sid.get('{'+NS['r']+'}id')]
            member = posixpath.normpath(posixpath.join('ppt', target)) if not target.startswith('/') else target.lstrip('/')
            root = ET.fromstring(z.read(member))
            slide_rel = posixpath.join(posixpath.dirname(member), '_rels', posixpath.basename(member)+'.rels')
            layout = None
            if slide_rel in z.namelist():
                for rel in ET.fromstring(z.read(slide_rel)):
                    if rel.get('Type','').endswith('/slideLayout'):
                        lp = posixpath.normpath(posixpath.join(posixpath.dirname(member), rel.get('Target')))
                        if lp in z.namelist():
                            lr = ET.fromstring(z.read(lp)); cs = lr.find('p:cSld', NS)
                            layout = {'type': lr.get('type'), 'name': cs.get('name') if cs is not None else None}
            fonts = [e.get('typeface') for e in root.iter() if e.get('typeface')]
            sizes = sorted(set(round(int(e.get('sz'))/100, 2) for e in root.iter() if str(e.get('sz','')).isdigit()))
            # Structure only: source slide copy is deliberately excluded from the content pipeline.
            placeholders = [e.get('type','body') for e in root.findall('.//p:ph', NS)]
            pages.append({'pageNo': n, 'metadata': {'fonts': list(dict.fromkeys(fonts)), 'fontSizesPt': sizes, 'layout': layout, 'placeholders': placeholders}})
        return pages, {'themes': themes, 'slideSizeEmu': dict(size.attrib) if size is not None else {}}

def sanitize_pptx_for_render(source, destination):
    """Create a local render copy with no externally addressable relationships.

    Preserve the uploaded bytes. Targets are inspected only as XML attributes;
    no URL resolution, validation or network request is performed.
    """
    removed_links = 0
    removed_resources = 0
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as output:
        for info in archive.infolist():
            data = archive.read(info.filename)
            if info.filename.endswith('.rels'):
                root = ET.fromstring(data)
                changed = False
                for relation in list(root):
                    if relation.get('TargetMode', '').lower() == 'external':
                        if relation.get('Type', '').endswith('/hyperlink'):
                            removed_links += 1
                        else:
                            removed_resources += 1
                        root.remove(relation)
                        changed = True
                if changed:
                    data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
            output.writestr(info, data)
    warnings = []
    if removed_links:
        warnings.append(f'预览副本已移除 {removed_links} 个外部超链接；原始 PPTX 保持不变。')
    if removed_resources:
        warnings.append(f'预览副本已移除 {removed_resources} 个外部资源引用，未下载链接素材；相关图片或媒体可能缺失，本地嵌入素材照常保留。')
    return warnings

def parse(manifest, out):
    out.mkdir(parents=True, exist_ok=True)
    pages = []; deck_meta = {}
    for item in manifest['files']:
        source = Path(item['path'])
        if source.suffix.lower() == '.pptx':
            page_meta, deck_meta = ppt_metadata(source)
            soffice = os.environ.get('PPT_SOFFICE') or shutil.which('soffice')
            if not soffice: raise RuntimeError('未找到 LibreOffice，无法渲染 PPTX 参考页')
            with tempfile.TemporaryDirectory(prefix='ppt-reference-') as temp:
                render_source = Path(temp, 'reference-render.pptx')
                warnings = sanitize_pptx_for_render(source, render_source)
                deck_meta['warnings'] = warnings
                for page in page_meta:
                    page['metadata']['warnings'] = warnings
                profile = Path(temp, 'profile').as_uri()
                result = subprocess.run([soffice, '-env:UserInstallation='+profile, '--headless', '--convert-to', 'pdf', '--outdir', temp, str(render_source)], capture_output=True, text=True, timeout=150)
                pdf = Path(temp, render_source.stem+'.pdf')
                if result.returncode or not pdf.exists(): raise RuntimeError('PPTX 页面渲染失败，请确认文件可在 PowerPoint 中正常打开')
                import pypdfium2 as pdfium
                doc = pdfium.PdfDocument(str(pdf))
                if len(doc) != len(page_meta): raise RuntimeError('PPTX 渲染页数不一致，请重试或先导出页面图片')
                for n in range(len(doc)):
                    page = doc[n]; scale = min(1600 / page.get_width(), 1000 / page.get_height())
                    bitmap = page.render(scale=scale); im = bitmap.to_pil().convert('RGB')
                    pid = f'{item["id"]}-p{n+1:03d}'; dest = out / (pid+'.png'); im.save(dest)
                    pages.append({'id': pid, 'fileId': item['id'], 'width': im.width, 'height': im.height, 'path': str(dest), **page_meta[n]})
                    bitmap.close(); page.close()
                doc.close()
        elif source.suffix.lower() == '.pdf':
            import pypdfium2 as pdfium
            try:
                doc = pdfium.PdfDocument(str(source))
            except pdfium.PdfiumError as error:
                raise ValueError('PDF 无法打开，请确认文件完整且未设置打开密码') from error
            try:
                if not 0 < len(doc) <= MAX_PAGES:
                    raise ValueError(f'参考 PDF 需包含 1–{MAX_PAGES} 页，请先保留代表页')
                deck_meta = {'format': 'pdf', 'pageCount': len(doc)}
                # Rasterize local pages only; do not follow links, execute actions,
                # extract attachments, or add PDF text to the content pipeline.
                for n in range(len(doc)):
                    page = doc[n]
                    try:
                        width, height = page.get_width(), page.get_height()
                        if width <= 0 or height <= 0:
                            raise ValueError('PDF 页面尺寸无效')
                        bitmap = page.render(scale=min(1600 / width, 1000 / height))
                        try:
                            im = bitmap.to_pil().convert('RGB')
                            pid = f'{item["id"]}-p{n+1:03d}'; dest = out / (pid+'.png'); im.save(dest)
                            pages.append({'id': pid, 'fileId': item['id'], 'pageNo': n+1, 'width': im.width, 'height': im.height, 'path': str(dest),
                                          'metadata': {'format': 'pdf', 'pageSizePt': {'width': width, 'height': height}}})
                        finally:
                            bitmap.close()
                    finally:
                        page.close()
            finally:
                doc.close()
        else:
            with Image.open(source) as raw:
                if raw.format not in ('PNG','JPEG','WEBP'): raise ValueError('仅支持 PNG、JPEG、WebP 图片')
                im = ImageOps.exif_transpose(raw).convert('RGB'); original = im.size
                im.thumbnail((1800, 1200)); pid = item['id']+'-p001'; dest = out/(pid+'.png'); im.save(dest)
                pages.append({'id':pid,'fileId':item['id'],'pageNo':len(pages)+1,'width':im.width,'height':im.height,'path':str(dest),'metadata':{'originalWidth':original[0],'originalHeight':original[1]}})
    if not pages or len(pages)>MAX_PAGES: raise ValueError(f'最多使用 {MAX_PAGES} 张参考页')
    montage(pages, out / 'montage.png')
    return {'pages':pages,'metadata':deck_meta,'montagePath':str(out/'montage.png')}

def montage(pages, dest):
    cols = min(3,len(pages)); w=600; h=375
    sheet=Image.new('RGB',(cols*w,((len(pages)+cols-1)//cols)*h),'#e8edf3'); draw=ImageDraw.Draw(sheet)
    for n,page in enumerate(pages):
        with Image.open(page['path']) as im:
            im=im.convert('RGB'); im.thumbnail((w-20,h-36)); x=(n%cols)*w; y=(n//cols)*h
            sheet.paste(im,(x+(w-im.width)//2,y+25+(h-30-im.height)//2)); draw.text((x+10,y+8),str(n+1),fill='black')
    sheet.save(dest)

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('manifest');p.add_argument('output');p.add_argument('--montage-only',action='store_true');a=p.parse_args()
    try:
        manifest=json.loads(Path(a.manifest).read_text())
        if a.montage_only: montage(manifest['pages'],Path(a.output)); print('{}')
        else: print(json.dumps(parse(manifest,Path(a.output)),ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error':str(e)},ensure_ascii=False)); raise SystemExit(1)
