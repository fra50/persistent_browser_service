from bs4 import BeautifulSoup
from pathlib import Path
html = Path('last_search.html').read_text(encoding='utf-8', errors='ignore')
soup = BeautifulSoup(html, 'html.parser')
for sel in ['.VwiC3b', '.yXK7lf', '.MUxGbd span', '.st']:
    els = soup.select(sel)
    print(sel, len(els))
