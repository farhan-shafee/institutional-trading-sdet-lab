"""Independent selected live framing/profile oracle; no TypeScript or database imports."""
import hashlib,json,re,sys
from functools import lru_cache
from pathlib import Path
from fix44_reference import ProtocolError,require,parse_wire,timestamp,Dictionary44,check_profile
ROOT=Path(__file__).resolve().parents[2]
@lru_cache(maxsize=1)
def dictionary():return Dictionary44()

def parse_live_wire(raw):
    require(isinstance(raw,bytes),'INPUT')
    f=parse_wire(raw)
    require(f.get(43) in (None,'Y'),'LIVE_REPLAY')
    require((43 in f)==(122 in f),'LIVE_REPLAY')
    header=[8,9,35,34]+([43] if 43 in f else [])+[49,52,56]+([122] if 122 in f else [])
    ordered=[int(piece.split(b'=',1)[0]) for piece in raw[:-1].split(b'\x01')]
    require(ordered[:len(header)]==header,'LIVE_HEADER_ORDER')
    for tag in (52,122):
        if tag in f:
            require(re.fullmatch(r'[0-9]{8}-[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}',f[tag]) is not None,'LIVE_PRECISION')
            require(1900<=timestamp(f[tag]).year<=2199,'LIVE_TIMESTAMP')
    require(re.fullmatch('[1-9][0-9]{0,9}',f.get(34,'')) is not None and int(f[34])<=2147483647,'LIVE_SEQUENCE')
    mt=f.get(35);require(mt in ('D','8','F','9'),'LIVE_MESSAGE')
    outgoing=mt in ('D','F')
    require((f[49],f[56])==(('TRADEFLOW','ATLAS') if outgoing else ('ATLAS','TRADEFLOW')),'LIVE_DIRECTION')
    terms={55,167,54,854,38,40,59,423,44,15,64}
    required={11,60}
    optional=set()
    if mt=='D':required|=terms|{21};optional={75};require(f.get(21)=='1','LIVE_HANDLING')
    elif mt=='8':required|=terms|{37,17,150,39,14,151,6};optional={41,32,31,75,103,58}
    elif mt=='F':required|={41,37,55,167,54,38};optional={58}
    else:required|={37,41,39,434,102};optional={58}
    require(required.issubset(f),'LIVE_REQUIRED')
    require(set(f).issubset(set(header)|{10}|required|optional),'LIVE_MEMBERSHIP')
    for tag in (11,41):
        if tag in f:require(re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',f[tag]) is not None,'LIVE_UUID')
    for tag in (37,17):
        if tag in f:require(re.fullmatch('ATLAS-[A-Z0-9-]{1,48}',f[tag]) is not None,'LIVE_DEALER_ID')
    require(1900<=timestamp(f[60]).year<=2199,'LIVE_BUSINESS_TIME')
    require(f.get(58) in (None,'SYNTHETIC_REJECTION','SYNTHETIC_CANCEL_REJECT','SYNTHETIC_CANCEL_REQUEST'),'LIVE_TEXT')
    if mt=='F':
        require((f[55],f[167]) in (('SYN-UST-2031','TNOTE'),('SYN-CORP-2031','CORP')) and f[54] in ('1','2'),'LIVE_INSTRUMENT')
        require(re.fullmatch(r'(0|[1-9][0-9]{0,9})\.[0-9]{2}',f[38]) is not None and 100<=int(f[38].replace('.',''))<=100000000000,'LIVE_QUANTITY')
    if mt=='8':require((f[150]=='8' and f.get(103) in ('6','99')) or (f[150]!='8' and 103 not in f),'LIVE_REJECTION')
    dictionary().validate(f);check_profile(f)
    return f

def main():
    payload=sys.stdin.buffer.read(65537);require(len(payload)<=65536,'HARNESS_LIMIT')
    observed=json.loads(payload)
    rows=json.loads((ROOT/'test-data/fix44/live/manifest.json').read_text())
    require(len(rows)==20 and len(observed)==20,'HARNESS_CASES')
    require(len({r['name'] for r in rows})==20 and {r['name'] for r in observed}=={r['name'] for r in rows},'HARNESS_CASES')
    for row in rows:
        raw=bytes.fromhex(row['raw_hex']);require(hashlib.sha256(raw).hexdigest()==row['sha256'],'RAW_HASH')
        accepted=True
        try:fields=parse_live_wire(raw)
        except ProtocolError:accepted=False;fields=None
        require(accepted is row['accepted'],'LITERAL_VERDICT')
        result=next(r for r in observed if r['name']==row['name'])
        require(result['accepted'] is accepted and result['sha256']==row['sha256'],'NODE_CORRESPONDENCE')
        if accepted:
            expected={str(k):v for k,v in fields.items()}
            require(expected==row['fields'] and result['fields']==expected,'EXACT_FIELDS')
    print('Independent live byte/profile oracle:20/20 literal verdicts; financial application unverified.')
if __name__=='__main__':main()
