"""把单字重的内置中文字体"造"出一个粗体字面。

背景：得意黑（Smiley Sans）与思源黑体（Noto Sans SC）在仓库里都只有 Regular 一个字重，
而客户端的字体链（Typeface.CustomFallbackBuilder）只有一个字面 —— Android 的合成粗体
在这条链上不生效，于是 Markdown 的 **粗体** 完全看不出来。这里用轮廓外扩（每个点沿外法线
往外推）造出真粗体字面，供粗体链使用。

授权：两者都是 SIL OFL 1.1。得意黑带 Reserved Font Name <Smiley> / <得意黑>，所以改出来的
字面**必须改名**（这里叫 DSH Hei Bold / DSH Sans Bold），版权与许可声明原样保留。

用法：python tools/make-bold-font.py
"""
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(HERE, "..", "android", "client", "src", "main", "res", "font")

# UPM 1000 下的外扩量。20 ≈ 2% em：CJK 笔画本来就密，再粗会糊。
DELTA = 20


class EmboldenPen(BasePen):
    """收下整条轮廓，按外法线外扩，再按**原来的段类型**画回去。

    注意：曲线段必须原样保留（curveTo / qCurveTo），不能压成折线 —— 否则字会变多边形。
    """

    def __init__(self, glyphSet, delta):
        super().__init__(glyphSet)
        self.delta = delta
        self.contours = []
        self.cur = None

    def _moveTo(self, pt):
        self.cur = [("m", [pt])]

    def _lineTo(self, pt):
        self.cur.append(("l", [pt]))

    def _curveToOne(self, p1, p2, p3):
        self.cur.append(("c", [p1, p2, p3]))

    def _qCurveToOne(self, p1, p2):
        self.cur.append(("q", [p1, p2]))

    def _closePath(self):
        if self.cur:
            self.contours.append(self.cur)
            self.cur = None

    def _endPath(self):
        self._closePath()

    @staticmethod
    def _area(pts):
        s = 0.0
        n = len(pts)
        for i in range(n):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % n]
            s += x1 * y2 - x2 * y1
        return s / 2.0

    def _offset(self, flat):
        d = self.delta
        n = len(flat)
        if n < 3:
            return list(flat)
        # 轮廓方向决定外侧：y 轴向上时，逆时针（面积 > 0）的外法线是切线右转 90 度。
        sign = 1.0 if self._area(flat) > 0 else -1.0
        out = []
        for i in range(n):
            px, py = flat[(i - 1) % n]
            cx, cy = flat[i]
            nx, ny = flat[(i + 1) % n]
            tx, ty = nx - px, ny - py
            ln = (tx * tx + ty * ty) ** 0.5
            if ln < 1e-9:
                out.append((cx, cy))
                continue
            ux, uy = tx / ln, ty / ln
            vx, vy = sign * uy, -sign * ux
            out.append((cx + vx * d, cy + vy * d))
        # 整体右移 d/2：加粗在左右均分，不然左侧会压到前一个字
        return [(x + d / 2.0, y) for (x, y) in out]

    def glyph(self):
        pen = TTGlyphPen(None)
        for ops in self.contours:
            flat = []
            for _kind, pts in ops:
                flat.extend(pts)
            moved = self._offset(flat)
            k = 0
            for kind, pts in ops:
                seg = moved[k:k + len(pts)]
                k += len(pts)
                if kind == "m":
                    pen.moveTo(seg[0])
                elif kind == "l":
                    pen.lineTo(seg[0])
                elif kind == "c":
                    pen.curveTo(seg[0], seg[1], seg[2])
                elif kind == "q":
                    pen.qCurveTo(*seg)
            pen.closePath()
        return pen.glyph()


def embolden_outlines(font, delta):
    """静态字体：每个轮廓沿外法线外扩 delta。"""
    glyf = font["glyf"]
    hmtx = font["hmtx"]
    gs = font.getGlyphSet()
    order = font.getGlyphOrder()
    made = 0
    for name in order:
        g = glyf[name]
        if g.isComposite() or g.numberOfContours <= 0:
            continue
        pen = EmboldenPen(gs, delta)
        g.draw(pen, glyf)
        glyf[name] = pen.glyph()
        adv, lsb = hmtx[name]
        hmtx[name] = (adv + delta, lsb)
        made += 1
    return made, len(order)


def finish(font, dst, family, ps_name, made, total, note):
    """统一的收尾：字重标记、改名（OFL 保留字名）、丢失效 hinting、保存。"""
    glyf = font["glyf"]
    hmtx = font["hmtx"]
    gs = font.getGlyphSet()
    order = font.getGlyphOrder()
    made = 0
    for name in order:
        g = glyf[name]
        if g.isComposite() or g.numberOfContours <= 0:
            continue
        pen = EmboldenPen(gs, DELTA)
        g.draw(pen, glyf)
        glyf[name] = pen.glyph()
        adv, lsb = hmtx[name]
        hmtx[name] = (adv + DELTA, lsb)
        made += 1
    font["OS/2"].usWeightClass = 700
    font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0x40) | 0x20
    font["head"].macStyle = font["head"].macStyle | 0x01
    # 可变字体实例化后 gvar/HVAR/fvar 已经没了；静态字体本来就没有
    try:
        font["OS/2"].panose.bWeight = 7
    except Exception:
        pass
    name = font["name"]
    repl = {1: family, 2: "Bold", 3: family + "; Bold", 4: family, 6: ps_name, 16: family, 17: "Bold"}
    for rec in list(name.names):
        if rec.nameID in repl:
            name.setName(repl[rec.nameID], rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    # 轮廓改了，旧 hinting 一律作废（Android 走 FreeType 自动微调，不需要它们）
    for tag in ("fpgm", "prep", "cvt ", "hdmx", "VDMX", "LTSH", "gasp"):
        if tag in font:
            del font[tag]
    font.save(dst)
    print("  %s：%s，字形 %d / %d，%.1f MB" % (
        os.path.basename(dst), note, made, total, os.path.getsize(dst) / 1048576.0))


def build(src, dst, family, ps_name, delta, wght):
    font = TTFont(src)
    order = font.getGlyphOrder()
    if wght is not None and "fvar" in font:
        # 可变字体：直接实例化到目标字重，这是**真字重**，比描边模拟正统得多
        from fontTools.varLib import instancer
        font = instancer.instantiateVariableFont(font, {"wght": wght}, inplace=True, updateFontNames=False)
        made, total, note = len(order), len(order), "wght=%d 实例化" % wght
    else:
        made, total = embolden_outlines(font, delta)
        note = "轮廓外扩 %d 单位" % delta
    finish(font, dst, family, ps_name, made, total, note)


def main():
    jobs = [
        # 得意黑是静态字体（只有一个字面）—— 只能轮廓外扩造粗体
        ("smiley_sans_oblique.ttf", "dsh_hei_bold.ttf", "DSH Hei Bold", "DSHHei-Bold", DELTA, None),
        # 思源黑体是可变字体（wght 100-900）—— 实例化到 700，真字重
        ("noto_sans_sc.ttf", "dsh_sans_bold.ttf", "DSH Sans Bold", "DSHSans-Bold", DELTA, 700),
    ]
    for src, dst, family, ps, delta, wght in jobs:
        build(os.path.join(FONT_DIR, src), os.path.join(FONT_DIR, dst), family, ps, delta, wght)


if __name__ == "__main__":
    sys.exit(main())
