import re
from pathlib import Path
html = Path('maps_braserie_paris.html').read_text(encoding='utf-8', errors='ignore')
matches = re.findall(r'aria-label=\"([^\"]+)\"', html)
filtered = [m for m in matches if 'Brasserie' in m or 'Paris' in m]
for item in filtered[:5]:
    print(item)
if not filtered:
    print('No matches')
