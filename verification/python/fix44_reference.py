"""Independent stdlib byte oracle and base-FIX4.4 XML dictionary checker.

No TypeScript/profile implementation imports. Not a QuickFIX session engine.
Only the four approved flat application messages are checked; groups/data unsupported.
"""
from datetime import datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
DICTIONARY_SHA256 = 'a82655b54363aa9c6d1b2f21f294f1198c0d7125d7b44c26d93d3179f3358425'

class ProtocolError(ValueError):
    """Fixed diagnostic codes only: no untrusted messages/field values."""

def require(condition, code):
    if not condition: raise ProtocolError(code)

def reference_frame(pairs):
    """Fixture/test reference constructor, independent byte counts and checksum."""
    body = b''.join(str(k).encode('ascii') + b'=' + v.encode('ascii') + bytes([1]) for k,v in pairs)
    start = b'8=FIX.4.4\x019=' + str(len(body)).encode('ascii') + b'\x01' + body
    return start + b'10=' + ('%03d' % (sum(start) & 255)).encode('ascii') + b'\x01'

def parse_wire(wire):
    require(0 < len(wire) <= 8192, 'FRAME_LIMIT')
    require(all(c == 1 or 32 <= c <= 126 for c in wire), 'ASCII')
    require(wire.endswith(b'\x01'), 'TRUNCATED')
    pieces = wire[:-1].split(b'\x01')
    require(len(pieces) <= 64, 'FIELD_LIMIT')
    fields = {}
    tags = []
    for piece in pieces:
        match = re.fullmatch(rb'([1-9][0-9]{0,4})=([ -~]{1,256})',piece)
        require(match is not None, 'FRAMING')
        tag = int(match[1]); require(tag not in fields,'DUPLICATE')
        fields[tag] = match[2].decode('ascii'); tags.append(tag)
    require(tags[:3] == [8,9,35] and tags[-1] == 10, 'ORDER')
    require(fields[8] == 'FIX.4.4','VERSION')
    require(re.fullmatch('[1-9][0-9]{0,4}',fields[9]) is not None,'LENGTH')
    start = wire.index(b'\x01',wire.index(b'\x01')+1)+1
    end = wire.rfind(b'10=')
    require(end > 0 and wire[end-1] == 1 and end-start == int(fields[9]),'LENGTH')
    require(re.fullmatch('[0-9]{3}', fields[10]) is not None and int(fields[10]) == sum(wire[:end]) % 256,'CHECKSUM')
    return fields

def timestamp(value):
    require(re.fullmatch(r'\d{8}-\d{2}:\d{2}:\d{2}(?:\.\d{3})?',value) is not None,'TIMESTAMP')
    try: return datetime.strptime(value,'%Y%m%d-%H:%M:%S.%f' if '.' in value else '%Y%m%d-%H:%M:%S')
    except ValueError: raise ProtocolError('TIMESTAMP') from None

class Dictionary44:
    """Reads unmodified pinned QuickFIX XML, independently expands components.

    Checks flat field membership, presence of required fields (including required
    components), FIX primitive formats and dictionary enums. Does not purport to
    implement prose-only conditional rules or a full FIX validation engine.
    """
    def __init__(self):
        license_bytes=(ROOT / 'verification/vendor/quickfix/LICENSE').read_bytes()
        require(hashlib.sha256(license_bytes).hexdigest() == '04719eefe7adf383d7970d7654caec6f7e542e6427f25d068e7177495fc9b379','LICENSE_HASH')
        raw=(ROOT / 'verification/vendor/quickfix/FIX44.xml').read_bytes()
        require(hashlib.sha256(raw).hexdigest() == DICTIONARY_SHA256,'DICTIONARY_HASH')
        self.root=ET.fromstring(raw)
        require(self.root.attrib == {'type':'FIX','major':'4','minor':'4','servicepack':'0'},'DICTIONARY_VERSION')
        self.by_name={x.attrib['name']:x for x in self.root.find('fields')}
        self.by_tag={int(x.attrib['number']):x for x in self.root.find('fields')}
        self.components={x.attrib['name']:x for x in self.root.find('components')}

    def expand(self, node, mandatory=True):
        allowed=set();required=set();groups=set()
        for item in node:
            name=item.attrib['name'];needed=mandatory and item.attrib['required']=='Y'
            if item.tag == 'component':
                a,r,g=self.expand(self.components[name],needed);allowed |= a;required |= r;groups |= g
            else:
                tag=int(self.by_name[name].attrib['number']);allowed.add(tag)
                if item.tag == 'group': groups.add(tag)
                elif needed: required.add(tag)
        return allowed, required, groups

    def validate(self, fields):
        mt=fields.get(35);require(mt in ('D','8','F','9'),'DICTIONARY_MESSAGE')
        message=self.root.find(f"./messages/message[@msgtype='{mt}']")
        allowed=set();required=set();groups=set()
        for node in [self.root.find('header'), message, self.root.find('trailer')]:
            a,r,g=self.expand(node);allowed |= a;required |= r;groups |= g
        require(required.issubset(fields),'DICTIONARY_REQUIRED')
        require(set(fields).issubset(allowed),'DICTIONARY_MEMBERSHIP')
        require(not set(fields).intersection(groups),'UNSUPPORTED_GROUP')
        for tag,value in fields.items():
            definition=self.by_tag[tag];kind=definition.attrib['type'];enums={v.attrib['enum'] for v in definition}
            require(not enums or value in enums,'DICTIONARY_ENUM')
            require(bool(value),'DICTIONARY_EMPTY')
            if kind in ('INT','LENGTH','NUMINGROUP','SEQNUM','DAYOFMONTH'):
                require(re.fullmatch(r'\d+',value) is not None,'DICTIONARY_INTEGER')
            elif kind in ('PRICE','QTY','AMT','FLOAT','PRICEOFFSET','PERCENTAGE'):
                require(re.fullmatch(r'-?\d+(?:\.\d+)?',value) is not None,'DICTIONARY_DECIMAL')
            elif kind == 'UTCTIMESTAMP': timestamp(value)
            elif kind in ('LOCALMKTDATE','UTCDATEONLY'):
                require(re.fullmatch('[0-9]{8}',value) is not None,'DICTIONARY_DATE')
                try: datetime.strptime(value,'%Y%m%d')
                except ValueError: raise ProtocolError('DICTIONARY_DATE') from None
            elif kind == 'CHAR': require(len(value)==1,'DICTIONARY_CHAR')
            elif kind == 'BOOLEAN': require(value in ('Y','N'),'DICTIONARY_BOOLEAN')
            elif kind == 'CURRENCY': require(re.fullmatch('[A-Z]{3}',value) is not None,'DICTIONARY_CURRENCY')
            elif kind not in ('STRING','EXCHANGE','COUNTRY'): raise ProtocolError('UNSUPPORTED_DICTIONARY_TYPE')

# Independently authored economic-text and selected cross-field rules, not read
# from the TypeScript implementation or generated from encoder output.
def check_profile(f):
    mt=f.get(35);require(mt in ('D','8','F','9'),'PROFILE_MESSAGE')
    for tag in (49,56,34,52,11,60): require(tag in f,'PROFILE_REQUIRED')
    out=mt in ('D','F'); dealer=f[56] if out else f[49]
    require(dealer in ('ATLAS','BIRCH','CEDAR') and f[49 if out else 56]=='TRADEFLOW','PROFILE_DIRECTION')
    timestamp(f[52]);timestamp(f[60])
    if f.get(43)=='Y': require(122 in f and timestamp(f[122]) <= timestamp(f[52]),'PROFILE_REPLAY')
    else: require(122 not in f,'PROFILE_REPLAY')
    for tag in (37,17):
        if tag in f: require(f[tag].startswith(dealer+'-'),'PROFILE_DEALER_ID')
    for tag in (38,14,151,32):
        if tag in f:
            require(re.fullmatch(r'(?:0|[1-9][0-9]{0,9})\.\d{2}',f[tag]) is not None,'PROFILE_QUANTITY')
            require(Decimal(f[tag]) <= Decimal('1000000000.00'),'PROFILE_QUANTITY')
    for tag in (44,31,6):
        if tag in f: require(re.fullmatch(r'(?:0|[1-9][0-9]{0,4})\.\d{12}',f[tag]) is not None,'PROFILE_PRICE')
    if mt in ('D','8'):
        require(all(tag in f for tag in (44,38,55,167,54,40,59,423,15,64,854)),'PROFILE_REQUIRED')
        require(Decimal(f[44])>0 and Decimal(f[38])>=1,'PROFILE_POSITIVE')
        require(re.fullmatch('[0-9]{8}',f[64]) is not None and '20250115' <= f[64] < '20310115','PROFILE_SETTLEMENT')
        try: datetime.strptime(f[64],'%Y%m%d')
        except ValueError: raise ProtocolError('PROFILE_SETTLEMENT') from None
        require((f[55],f[167]) in (('SYN-UST-2031','TNOTE'),('SYN-CORP-2031','CORP')),'PROFILE_INSTRUMENT')
        require(f[54] in ('1','2') and (f[40],f[59],f[423],f[15],f[854]) == ('2','1','1','USD','0'),'PROFILE_TERMS')
    if mt=='8':
        require(all(tag in f for tag in (150,39,14,151,6)),'PROFILE_REQUIRED')
        q,c,l=(Decimal(f[tag]) for tag in (38,14,151))
        require(0 <= c <= q and 0 <= l <= q and f[6]==(f[44] if c else '0.000000000000'),'PROFILE_TOTALS')
        require(f[150] in ('0','8','F','6','4'),'PROFILE_EXEC_TYPE')
        if f[150]=='F':
            require(32 in f and 31 in f and 41 not in f,'PROFILE_TRADE_FIELDS')
            require(f[31]==f[44] and 0 < Decimal(f[32]) <= c and c > 0 and c+l==q,'PROFILE_TRADE')
            require(f[39] in ('1','2','6') and not (f[39]=='1' and c==q) and not (f[39]=='2' and c!=q),'PROFILE_STATUS')
        else:
            require(31 not in f and 32 not in f and f[150]==f[39],'PROFILE_STATUS')
            if f[150]=='0': require(c==0 and l==q,'PROFILE_NEW')
            if f[150]=='8': require(c==0 and l==0 and 103 in f,'PROFILE_REJECT')
            if f[150]=='4': require(l==0 and c<q and 41 in f,'PROFILE_CANCEL')
            if f[150]=='6': require(c+l==q and 41 in f,'PROFILE_PENDING_CANCEL')
    if mt=='D': require(37 not in f,'PROFILE_NO_DEALER_ID')
    if mt in ('F','9'): require(41 in f and f[11]!=f[41],'PROFILE_CANCEL_ID')
    if mt=='9': require(17 not in f and f[434]=='1' and f[39] in ('0','1','2') and f[102] in ('0','99') and (f[102]=='0')==(f[39]=='2'),'PROFILE_CANCEL_REJECT')

if __name__ == '__main__':
    # Bounded trusted test harness: supplied encoded messages must match fixed raw
    # goldens, then pass independently counted bytes + base dictionary + semantics.
    import base64
    payload=sys.stdin.buffer.read(65537);require(len(payload)<=65536,'HARNESS_LIMIT')
    encoded=json.loads(payload);dictionary=Dictionary44()
    fixtures=json.loads((ROOT / 'test-data/fix44/manifest.json').read_text())
    require(set(encoded)=={f['name'] for f in fixtures},'HARNESS_CASES')
    for fixture in fixtures:
        raw=base64.b64decode(encoded[fixture['name']],validate=True)
        require(raw==(ROOT/'test-data/fix44'/fixture['file']).read_bytes(),'GOLDEN_BYTES')
        fields=parse_wire(raw);dictionary.validate(fields);check_profile(fields)
    print(f"Independent byte oracle + pinned base FIX4.4 dictionary: {len(fixtures)} TypeScript-encoded frames verified; no session-engine claim.")
