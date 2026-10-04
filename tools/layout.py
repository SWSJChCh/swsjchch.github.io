#!/usr/bin/env python3
"""Regenerate the three checked layouts. Optional development dependency: Graphviz `dot`.

The deployed page needs neither Graphviz nor any Python package. Projection edges
always contain their complete underlying paths; they are not new adviser claims.
"""
from __future__ import annotations
import json, subprocess
from collections import defaultdict
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def projection(data, visible):
    people={p['id']:p for p in data['people']}
    out=defaultdict(list)
    def walk(current,reverse_path):
        for a in people[current]['advisors']:
            path=reverse_path+[a]
            if a in visible:
                out[(a,reverse_path[0])].append(list(reversed(path)))
            else: walk(a,path)
    for p in visible: walk(p,[p])
    edges=[]
    for (a,s),paths in out.items():
        counts=[len(p)-2 for p in paths]
        collapsed=any(counts)
        edges.append({'key':a+'>'+s,'advisor':a,'student':s,'paths':paths,'collapsed':collapsed,'hiddenMin':min(counts),'hiddenMax':max(counts)})
    return edges

def build(data,ids,view):
    edges=projection(data,set(ids))
    lines=['digraph G {','graph [rankdir=TB, nodesep=.42, ranksep=.36, pad=.05, splines=true, outputorder=edgesfirst];', 'node [shape=box, width=3.72222, height=1.13889, fixedsize=true, label=""];','edge [arrowsize=.5, fontsize=15, fontname="monospace"];']
    for id in ids:lines.append('"'+id+'";')
    for e in edges:
        label=f'+{e["hiddenMin"]}' if e['hiddenMin']==e['hiddenMax'] else f'+{e["hiddenMin"]}–{e["hiddenMax"]}'
        attrs=f'label="{label}", ' if e['collapsed'] else ''
        lines.append(f'"{e["advisor"]}" -> "{e["student"]}" [{attrs}id="{e["key"]}"];')
    lines.append('}')
    result=subprocess.run(['dot','-Tjson'],input='\n'.join(lines),text=True,capture_output=True,check=True)
    g=json.loads(result.stdout);bb=list(map(float,g['bb'].split(',')));height=bb[3]
    nodes={}
    for o in g['objects']:
        x,y=map(float,o['pos'].split(','));nodes[o['name']]={'x':round(x-134,2),'y':round(height-y-41,2)}
    bykey={e['key']:e for e in edges}
    for e in g['edges']:
        out=bykey[e['id']];parts=[];first=None;last=None
        for cmd in e.get('_draw_',[]):
            if cmd['op']=='b':
                pts=[(round(x,2),round(height-y,2)) for x,y in cmd['points']]
                first=pts[0];last=pts[-1]
                parts.append('M '+','.join(map(str,pts[0]))+' C '+' '.join(','.join(map(str,p)) for p in pts[1:]))
        out['d']=' '.join(parts)
        if 'lp' in e:
            x,y=map(float,e['lp'].split(','));out['badge']={'x':x,'y':round(height-y,2)}
        else:out['badge']={'x':round((first[0]+last[0])/2,2),'y':round((first[1]+last[1])/2,2)}
    return {'nodes':nodes,'edges':edges,'width':bb[2],'height':height}

def main():
    f=ROOT/'assets/genealogy-data.json';d=json.loads(f.read_text())
    d['layouts']={}
    for view,ids in [('highlights',d['meta']['highlights']),('recent',d['meta']['recent']),('all',[p['id'] for p in d['people']])]:
        d['layouts'][view]=build(d,ids,view)
        print(view,len(ids),'nodes',len(d['layouts'][view]['edges']),'edges',d['layouts'][view]['width'],d['layouts'][view]['height'])
    for p in d['people']:p.update(d['layouts']['all']['nodes'][p['id']])
    f.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
if __name__=='__main__':main()
