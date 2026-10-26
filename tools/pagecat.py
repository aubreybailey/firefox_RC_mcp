#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["selenium>=4.11", "trafilatura>=1.9"]
# ///
"""pagecat: render a URL in your real Firefox (headless) using a snapshot of
your profile (cookies, history, storage), then print it as text.

Formats:
  outline  screen-reader view: landmarks, headings, links, controls, text (default)
  md       main article content as markdown (readability-style)
  html     raw rendered DOM
"""
import argparse, glob, os, shutil, sys, tempfile, time

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

PROFILE_GLOBS = [
    "~/.config/mozilla/firefox/*.default-release",            # Linux (XDG, newer)
    "~/.mozilla/firefox/*.default-release",                   # Linux (legacy)
    "~/snap/firefox/common/.mozilla/firefox/*.default*",      # Linux (snap)
    "~/Library/Application Support/Firefox/Profiles/*.default-release",  # macOS
]
# Snap Firefox has a private /tmp, so the profile copy must live where it can
# see it, and it only starts under the snap's own geckodriver.
SNAP_GECKODRIVER = "/snap/bin/geckodriver"
SNAP_TMP = os.path.expanduser("~/snap/firefox/common")
# Locks would block launch; caches are bulk; session files would restore old tabs.
SKIP = shutil.ignore_patterns("lock", ".parentlock", "parent.lock", "cache2",
                              "startupCache", "sessionstore*", "crashes", "minidumps")

# Walks the visible DOM the way a screen reader linearizes it.
OUTLINE_JS = r"""
const LANDMARK = {NAV:'nav', MAIN:'main', HEADER:'banner', FOOTER:'contentinfo',
                  ASIDE:'complementary', FORM:'form', DIALOG:'dialog'};
const ROLES = new Set(Object.values(LANDMARK).concat(['navigation','search','region']));
const BLOCK = new Set(['P','LI','TD','TH','DD','DT','BLOCKQUOTE','PRE','FIGCAPTION','CAPTION']);
const IGNORE = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','IFRAME','HEAD']);
const NESTED = 'a,button,input,select,textarea,h1,h2,h3,h4,h5,h6,[role]';

const clip = (s, n = 160) => {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const label = el => clip(
  el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.alt ||
  el.title || el.placeholder || el.innerText);
// checkVisibility() is false for display:contents boxes (e.g. MDN's <main>),
// though their children render, so those count as visible.
const hidden = el => IGNORE.has(el.tagName) || el.getAttribute('aria-hidden') === 'true' ||
  (el.checkVisibility && !el.checkVisibility() && getComputedStyle(el).display !== 'contents');
// What actually renders: a shadow root's tree (slots pull light DOM in) or the children.
const kids = el => el.tagName === 'SLOT' ? el.assignedNodes({flatten: true}) :
  (el.shadowRoot || el).childNodes;

const out = [];
function walk(el, d) {
  if (hidden(el)) return;
  const pad = '  '.repeat(d), t = el.tagName, role = el.getAttribute('role');
  const emit = s => out.push(pad + s);

  const h = /^H([1-6])$/.exec(t);
  if (h || role === 'heading')
    return emit('#'.repeat(h ? +h[1] : +(el.getAttribute('aria-level') || 2)) + ' ' + label(el));
  if ((t === 'A' && el.hasAttribute('href')) || role === 'link')
    return emit(`link "${label(el)}" ${el.getAttribute('href') || ''}`);
  if (t === 'BUTTON' || role === 'button')
    return emit(`button "${label(el)}"`);
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA')
    return el.type !== 'hidden' && emit(`${t === 'INPUT' ? el.type : t.toLowerCase()} "${label(el)}"`);
  if (t === 'IMG')
    return el.alt && emit(`img "${clip(el.alt)}"`);

  const lm = ROLES.has(role) ? role : LANDMARK[t];
  if (lm) { emit(`[${lm}]`); d++; }
  else if (BLOCK.has(t) && !el.querySelector(NESTED)) {
    const s = clip(el.innerText, 2000);
    return s && emit(s);
  }
  for (const c of kids(el)) {
    if (c.nodeType === Node.ELEMENT_NODE) walk(c, d);
    else if (c.nodeType === Node.TEXT_NODE) {
      const s = clip(c.nodeValue, 2000);
      if (s) out.push('  '.repeat(d) + s);
    }
  }
}
walk(document.body, 0);
return out.filter((l, i) => l !== out[i - 1]).join('\n');
"""


def find_profile() -> str:
    for pattern in PROFILE_GLOBS:
        if hits := glob.glob(os.path.expanduser(pattern)):
            return max(hits, key=os.path.getmtime)
    sys.exit("No Firefox profile found; pass --profile")


def render(url: str, profile: str, wait: float, headless: bool, fmt: str) -> str:
    snap_ff = os.path.exists(SNAP_GECKODRIVER)
    tmp = tempfile.mkdtemp(dir=SNAP_TMP if snap_ff else None, prefix="pagecat-")
    try:
        snap = shutil.copytree(profile, os.path.join(tmp, "profile"), ignore=SKIP)
        opts = Options()
        if headless:
            opts.add_argument("-headless")
        opts.add_argument("-profile")   # geckodriver uses this copy in place
        opts.add_argument(snap)
        # Otherwise Selenium Manager fetches geckodriver.
        service = Service(executable_path=SNAP_GECKODRIVER) if snap_ff else None
        driver = webdriver.Firefox(options=opts, service=service)
        try:
            driver.get(url)             # returns after document load
            time.sleep(wait)            # let JS / challenge pages settle
            if fmt == "outline":
                return driver.execute_script(OUTLINE_JS)
            html = driver.page_source
        finally:
            driver.quit()
    finally:
        # The copy holds your cookies, so make sure it goes. Firefox may still
        # be flushing files for a moment after quit().
        for _ in range(20):
            shutil.rmtree(tmp, ignore_errors=True)
            if not os.path.exists(tmp):
                break
            time.sleep(0.25)

    if fmt == "html":
        return html
    import trafilatura
    return trafilatura.extract(html, url=url, output_format="markdown",
                               include_links=True) or "(no main content found)"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("-f", "--format", choices=["outline", "md", "html"], default="outline")
    ap.add_argument("--profile", default=None, help="Firefox profile dir")
    ap.add_argument("--wait", type=float, default=2.0, help="seconds after load")
    ap.add_argument("--headed", action="store_true", help="show window (fewer tells)")
    a = ap.parse_args()
    print(render(a.url, a.profile or find_profile(), a.wait, not a.headed, a.format))


if __name__ == "__main__":
    main()
