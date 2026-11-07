"""Bounded wire admission for the owned fault transport, not a FIX session engine."""
import re

MAX_FRAME = 8192
MAX_BUFFER = 16384
MAX_FIELDS = 64
MAX_VALUE = 256
MAX_BATCH = 16
PREFIX = b"8=FIX.4.4\x019="

class WireError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

def _ascii(data):
    if any(byte != 1 and not 32 <= byte <= 126 for byte in data):
        raise WireError("NON_ASCII")

def _length(data):
    if not data: return None
    _ascii(data)
    if len(data) < len(PREFIX):
        if not PREFIX.startswith(data): raise WireError("FRAMING")
        return None
    if not data.startswith(PREFIX): raise WireError("FRAMING")
    end = data.find(b"\x01",len(PREFIX))
    if end == -1:
        number=data[len(PREFIX):]
        if number and not re.fullmatch(rb"[1-9][0-9]{0,4}",number):raise WireError("BODY_LENGTH")
        if number and int(number)+len(PREFIX)+len(number)+8>MAX_FRAME:raise WireError("FRAME_LIMIT")
        return None
    number=data[len(PREFIX):end]
    if not re.fullmatch(rb"[1-9][0-9]{0,4}",number):raise WireError("BODY_LENGTH")
    trailer=end+1+int(number)
    total=trailer+7
    if total>MAX_FRAME:raise WireError("FRAME_LIMIT")
    if len(data)<total:return None
    if data[trailer-1]!=1 or not re.fullmatch(rb"10=[0-9]{3}\x01",data[trailer:total]):
        raise WireError("BODY_LENGTH")
    if int(data[trailer+3:trailer+6]) != sum(data[:trailer])%256:raise WireError("CHECKSUM")
    return total

def decode_frame(raw):
    if not isinstance(raw,bytes) or not raw or len(raw)>MAX_FRAME:raise WireError("FRAME_LIMIT")
    length=_length(raw)
    if length is None:raise WireError("TRUNCATED")
    if length!=len(raw):raise WireError("TRAILING_BYTES")
    parts=raw[:-1].split(b"\x01")
    if len(parts)>MAX_FIELDS:raise WireError("FIELD_LIMIT")
    fields={}
    for part in parts:
        tag,sep,value=part.partition(b"=")
        if not sep or not re.fullmatch(rb"[1-9][0-9]{0,4}",tag) or not value or len(value)>MAX_VALUE:
            raise WireError("FIELD_VALUE")
        key=tag.decode("ascii")
        if key in fields:raise WireError("DUPLICATE_FIELD")
        fields[key]=value.decode("ascii")
    if list(fields)[:3]!=["8","9","35"] or list(fields)[-1]!="10":raise WireError("FIELD_ORDER")
    if any(tag not in fields for tag in ["35","49","56","34","52"]):raise WireError("HEADER_REQUIRED")
    if not re.fullmatch(r"[1-9][0-9]{0,9}",fields["34"]) or int(fields["34"])>2147483647:
        raise WireError("SEQUENCE_RANGE")
    return fields

def encode_fault_frame(fields):
    """Explicit fault fixture constructor; engine wire is captured unchanged elsewhere."""
    if not isinstance(fields,dict) or any(k in fields for k in ["8","9","10"]):raise WireError("RESERVED_FIELD")
    if len(fields)+3>MAX_FIELDS:raise WireError("FIELD_LIMIT")
    for tag,value in fields.items():
        if not isinstance(tag,str) or not re.fullmatch(r"[1-9][0-9]{0,4}",tag):raise WireError("FIELD_VALUE")
        if not isinstance(value,str) or not re.fullmatch(r"[\x20-\x7e]{1,256}",value):raise WireError("FIELD_VALUE")
    header=["35","49","56","34","43","52","122"]
    tags=[t for t in header if t in fields]+[t for t in fields if t not in header]
    body=b"".join(tag.encode()+b"="+fields[tag].encode("ascii")+b"\x01" for tag in tags)
    prefix=PREFIX+str(len(body)).encode()+b"\x01"+body
    raw=prefix+b"10="+f"{sum(prefix)%256:03d}".encode()+b"\x01"
    decode_frame(raw)
    return raw

class Framer:
    def __init__(self):
        self._buffer=b""
        self._failed=False
        self._blocked=False

    @property
    def blocked(self):return self._blocked

    def feed(self,chunk):
        if self._failed:raise WireError("PARSER_FAILED")
        if self._blocked and chunk:raise WireError("BACKPRESSURE")
        try:
            if not isinstance(chunk,bytes) or len(chunk)+len(self._buffer)>MAX_BUFFER:raise WireError("BUFFER_LIMIT")
            self._buffer+=chunk
            self._blocked=False
            messages=[]
            while self._buffer and len(messages)<MAX_BATCH:
                length=_length(self._buffer)
                if length is None:break
                raw=self._buffer[:length]
                decode_frame(raw)
                messages.append(raw)
                self._buffer=self._buffer[length:]
            self._blocked=len(messages)==MAX_BATCH and bool(self._buffer)
            return messages
        except WireError:
            self._failed=True
            self._buffer=b""
            raise

    def finish(self):
        if self._failed:raise WireError("PARSER_FAILED")
        if self._buffer:
            self._failed=True
            self._buffer=b""
            raise WireError("TRUNCATED")
