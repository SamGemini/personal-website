"""Pack parsed JSON into the compact files the reading page loads."""
import json, os, sys

# usage: python3 tools/pack.py <parsed bluetorch.json> <parsed moneystuff.json> <out dir, e.g. private>
BT_IN, MS_IN, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)

bt = json.load(open(BT_IN))
companies = []
for c in bt['companies']:
    companies.append({k: c[k] for k in ('id', 'name', 'ticker', 'fit', 'tierLetter', 'descriptor', 'fields', 'sources', 'page')})
tiers = {}
for c in bt['companies']:
    tiers[c['tierLetter']] = c['tier']
out = dict(
    heading='Blue Torch Deal Book', title=bt['intro']['title'], kicker=bt['intro']['kicker'], summary=bt['intro']['summary'],
    compiled=bt['intro']['compiled'], stats=bt['intro']['stats'],
    charts=bt['intro'].get('charts', []), pipelineCharts=bt.get('pipelineCharts', []),
    dealSections=bt['dealSections'],
    deals=[{k: d[k] for k in ('date', 'company', 'sector', 'structure', 'size', 'role', 'note', 'sources', 'section')} for d in bt['deals']],
    pipelineIntro=bt['pipelineIntro'], endMatter=bt['endMatter'], tiers=tiers, companies=companies,
)
json.dump(out, open(os.path.join(OUT, 'bluetorch.json'), 'w'), ensure_ascii=False, separators=(',', ':'))

ms = json.load(open(MS_IN))
arts = []
for a in ms['articles']:
    blocks = []
    for b in a['blocks']:
        if b['type'] == 'h':
            blocks.append({'h': b['text']})
        elif b.get('runs'):
            blocks.append({'r': b['runs']})
        else:
            blocks.append({'p': b['text']})
    arts.append(dict(id=a['id'], n=a['n'], title=a['title'], dek=a['dek'], date=a['date'], url=a['url'],
                     sections=a['sections'], blocks=blocks, footnotes=a['footnotes'], disclaimer=a['disclaimer'],
                     words=a['words']))
json.dump(dict(title=ms['title'], heading='Money Stuff', kicker='Bloomberg Opinion · Matt Levine', articles=arts), open(os.path.join(OUT, 'moneystuff.json'), 'w'),
          ensure_ascii=False, separators=(',', ':'))
for f in ('bluetorch.json', 'moneystuff.json'):
    print(f, os.path.getsize(os.path.join(OUT, f)))
