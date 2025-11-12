from bs4 import BeautifulSoup
from pathlib import Path
html = Path('maps_braserie_paris.html').read_text(encoding='utf-8', errors='ignore')
soup = BeautifulSoup(html, 'html.parser')
results = []
for item in soup.select('div[aria-label]'):
    label = item.get('aria-label', '').strip()
    if not label:
        continue
    if 'Brasserie' in label or 'brasserie' in label or 'Paris' in label:
        results.append(label)
    if len(results) >= 5:
        break
if results:
    for idx, label in enumerate(results, 1):
        print(f"{idx}. {label}")
else:
    print('No obvious results found; try inspecting the HTML manually to adjust selectors.')
