#!/usr/bin/env python3
"""Build the compact offline Maidenhead -> geography database used by FT8.

Inputs are GeoNames-compatible cities500.txt, admin1CodesASCII.txt and
countryInfo.txt files.  The generated browser module contains no network code.
GeoNames data is CC BY 4.0; keep docs/FT8_GEO_THIRD_PARTY.md with distributions.
"""
from __future__ import annotations
import argparse, json, math
from collections import defaultdict
from pathlib import Path
from scipy.spatial import cKDTree

MAX_FALLBACK_KM = 180.0
EARTH_KM = 6371.0088

def maiden4(lat: float, lon: float) -> str:
    lon = max(-180.0, min(179.999999, lon)); lat = max(-90.0, min(89.999999, lat))
    a = int((lon + 180.0) // 20.0); b = int((lat + 90.0) // 10.0)
    c = int(((lon + 180.0) - a * 20.0) // 2.0); d = int(((lat + 90.0) - b * 10.0) // 1.0)
    return f"{chr(65+a)}{chr(65+b)}{c}{d}"

def grid_index(g: str) -> int:
    return (((ord(g[0])-65)*18 + (ord(g[1])-65))*10 + int(g[2]))*10 + int(g[3])

def grid_from_index(i: int) -> str:
    d=i%10;i//=10;c=i%10;i//=10;b=i%18;a=i//18
    return f"{chr(65+a)}{chr(65+b)}{c}{d}"

def grid_center(g: str) -> tuple[float,float]:
    a=ord(g[0])-65;b=ord(g[1])-65;c=int(g[2]);d=int(g[3])
    return -90+b*10+d+0.5, -180+a*20+c*2+1.0

def xyz(lat: float, lon: float) -> tuple[float,float,float]:
    p=math.radians(lat); l=math.radians(lon); cp=math.cos(p)
    return cp*math.cos(l), cp*math.sin(l), math.sin(p)

def chord_to_km(chord: float) -> float:
    return EARTH_KM * 2.0 * math.asin(min(1.0, max(0.0, chord/2.0)))

def load_countries(path: Path):
    out={}
    for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if not raw or raw.startswith('#'): continue
        f=raw.rstrip('\r').split('\t')
        if len(f)>=9: out[f[0]]={'code':f[0], 'name':f[4], 'continent':f[8]}
    return out

def load_admin1(path: Path):
    out={}
    for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
        f=raw.rstrip('\r').split('\t')
        if len(f)>=2: out[f[0]]=f[1]
    return out

def load_cities(path: Path):
    cities=[]
    with path.open(encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            f=raw.rstrip('\n\r').split('\t')
            if len(f)<19: continue
            try:
                lat=float(f[4]); lon=float(f[5]); pop=int(f[14] or 0)
            except ValueError: continue
            cities.append({'name':f[1], 'lat':lat, 'lon':lon, 'country':f[8], 'admin1':f[10], 'pop':pop})
    return cities

def js_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',',':'))

def build(cities, countries, admin1):
    by_grid=defaultdict(list)
    points=[]
    for n,c in enumerate(cities):
        by_grid[maiden4(c['lat'],c['lon'])].append(c)
        points.append(xyz(c['lat'],c['lon']))
    tree=cKDTree(points)

    country_dict=[]; country_ids={}
    region_dict=['']; region_ids={'':0}
    city_dict=['']; city_ids={'':0}
    def cid(code):
        info=countries.get(code, {'code':code,'name':code,'continent':''})
        key=(info['code'],info['name'],info['continent'])
        if key not in country_ids:
            country_ids[key]=len(country_dict); country_dict.append(list(key))
        return country_ids[key]
    def sid(table, ids, value):
        value=value or ''
        if value not in ids: ids[value]=len(table); table.append(value)
        return ids[value]

    packed=[]; exact=0; fallback=0
    for idx in range(32400):
        g=grid_from_index(idx); candidates=by_grid.get(g)
        dist=0
        if candidates:
            # A 4-char FT8 locator is coarse.  The largest populated place in
            # the same locator is a useful representative label, not an exact city.
            chosen=max(candidates, key=lambda c:(c['pop'], c['name']))
            exact+=1
        else:
            lat,lon=grid_center(g); chord,n=tree.query(xyz(lat,lon)); km=chord_to_km(float(chord))
            if km>MAX_FALLBACK_KM: continue
            chosen=cities[int(n)]; dist=max(1,min(255,int(round(km))))
            fallback+=1
        region=admin1.get(f"{chosen['country']}.{chosen['admin1']}",'')
        packed.extend([idx,cid(chosen['country']),sid(region_dict,region_ids,region),sid(city_dict,city_ids,chosen['name']),dist])
    return country_dict,region_dict,city_dict,packed,exact,fallback

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--cities',required=True,type=Path);ap.add_argument('--admin1',required=True,type=Path);ap.add_argument('--countries',required=True,type=Path);ap.add_argument('--out',required=True,type=Path)
    args=ap.parse_args()
    countries=load_countries(args.countries);admin1=load_admin1(args.admin1);cities=load_cities(args.cities)
    C,R,Y,D,exact,fallback=build(cities,countries,admin1)
    text=f'''"use strict";\n/* FT8.6.5.19 offline Maidenhead geography. Derived from GeoNames data (CC BY 4.0).\n * See docs/FT8_GEO_THIRD_PARTY.md. City labels are representative/approximate for 4-char locators. */\n(function(root){{\nconst C={js_json(C)};\nconst R={js_json(R)};\nconst Y={js_json(Y)};\nconst D={js_json(D)};\nconst callCache=new Map();\nconst up=v=>String(v||"").trim().toUpperCase();\nfunction idx(grid){{const g=up(grid).replace(/\\s+/g,"");if(!/^[A-R]{{2}}\\d{{2}}(?:[A-X]{{2}}(?:\\d{{2}})?)?$/.test(g))return -1;return (((g.charCodeAt(0)-65)*18+(g.charCodeAt(1)-65))*10+Number(g[2]))*10+Number(g[3]);}}\nfunction find(i){{let lo=0,hi=D.length/5-1;while(lo<=hi){{const m=(lo+hi)>>1,k=D[m*5];if(k===i)return m*5;if(k<i)lo=m+1;else hi=m-1;}}return -1;}}\nfunction lookupGrid(grid){{const g=up(grid);const i=idx(g);if(i<0)return null;const p=find(i);if(p<0)return null;const c=C[D[p+1]]||["","",""];const distanceKm=D[p+4]||0;return{{grid:g,grid4:g.slice(0,4),countryCode:c[0]||"",country:c[1]||"",continent:c[2]||"",region:R[D[p+2]]||"",city:Y[D[p+3]]||"",approximate:true,nearby:Boolean(distanceKm),nearbyDistanceKm:distanceKm,source:"GeoNames offline"}};}}\nfunction remember(call,geo){{const k=up(call);if(k&&geo)callCache.set(k,{{...geo}});return geo;}}\nfunction lookupCall(call){{return callCache.get(up(call))||null;}}\nfunction resolve(call,grid){{const k=up(call),g=up(grid);let geo=g?lookupGrid(g):null;if(geo&&k)remember(k,geo);if(!geo&&k)geo=lookupCall(k);return geo?{{...geo}}:null;}}\nfunction clearCallCache(){{callCache.clear();}}\nroot.FreeRig710FT8Geo=Object.freeze({{lookupGrid,lookupCall,resolve,remember,clearCallCache,stats:Object.freeze({{records:{len(D)//5},exact:{exact},fallback:{fallback},maxFallbackKm:{int(MAX_FALLBACK_KM)}}})}});\n}})(typeof window!=="undefined"?window:globalThis);\n'''
    args.out.write_text(text,encoding='utf-8')
    print(f"wrote {args.out} bytes={args.out.stat().st_size} records={len(D)//5} exact={exact} fallback={fallback} cities={len(cities)}")
if __name__=='__main__':main()
