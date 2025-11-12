from bs4 import BeautifulSoup
from pathlib import Path
html = Path('last_search.html').read_text(encoding='utf-8', errors='ignore')
soup = BeautifulSoup(html, 'html.parser')
blocks = soup.select('#search .tF2Cxc, #search .Gx5Zad, #search .kvH3mc, #search .Ww4FFb')
print('blocks', len(blocks))
for block in blocks:
    h3 = block.find('h3')
    title = h3.get_text(strip=True) if h3 else 'No title'
    snippet = block.select_one('.VwiC3b, .yXK7lf, .MUxGbd span, .st')
    if snippet:
        print('snippet found for', title)
    else:
        print('no snippet', title)
