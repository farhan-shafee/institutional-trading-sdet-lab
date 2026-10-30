/** TradeFlow FIX44 bilateral profile v1. No financial/domain imports. */
export const HEADER = ['35', '49', '56', '34', '43', '52', '122'] as const;
const INSTRUMENT = ['55', '167', '54'];
const TERMS = [...INSTRUMENT, '854', '38', '40', '59', '423', '44', '15', '64'];
export const PROFILES = {
  D: { order: ['11', ...TERMS, '60', '75'], required: ['11', ...TERMS, '60'] },
  '8': {
    order: [
      '37',
      '17',
      '150',
      '39',
      '11',
      '41',
      ...TERMS,
      '14',
      '151',
      '6',
      '32',
      '31',
      '60',
      '75',
      '103',
      '58',
    ],
    required: ['37', '17', '150', '39', '11', ...TERMS, '14', '151', '6', '60'],
  },
  F: {
    order: ['11', '41', '37', ...INSTRUMENT, '60', '38', '58'],
    required: ['11', '41', '37', ...INSTRUMENT, '60', '38'],
  },
  '9': {
    order: ['37', '11', '41', '39', '434', '102', '60', '58'],
    required: ['37', '11', '41', '39', '434', '102', '60'],
  },
} as const;
export type MessageType = keyof typeof PROFILES;
export type FixFields = Readonly<Record<string, string>>;
export type Direction = 'CLIENT_TO_DEALER' | 'DEALER_TO_CLIENT';
export type ErrorCode =
  | 'TRUNCATED'
  | 'FRAMING'
  | 'VERSION'
  | 'BODY_LENGTH'
  | 'CHECKSUM'
  | 'FIELD_ORDER'
  | 'TRAILING_BYTES'
  | 'NON_ASCII'
  | 'MISSING_FIELD'
  | 'DUPLICATE_FIELD'
  | 'UNSUPPORTED_FIELD'
  | 'UNSUPPORTED_MESSAGE'
  | 'UNSUPPORTED_VALUE'
  | 'RESERVED_FIELD'
  | 'FIELD_LIMIT'
  | 'FIELD_LENGTH'
  | 'FRAME_LIMIT'
  | 'BUFFER_LIMIT'
  | 'BACKPRESSURE'
  | 'INVALID_LIMIT'
  | 'INVALID_VALUE'
  | 'PARSER_FAILED'
  | 'UNTRUSTED_MESSAGE';
/** Safe fixed code only: never retain untrusted payloads/identifiers in errors. */
export class Fix44Error extends Error {
  constructor(public readonly code: ErrorCode) {
    super(`FIX44 ${code}`);
    this.name = 'Fix44Error';
  }
}
export function fail(code: ErrorCode): never {
  throw new Fix44Error(code);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const dealerId = /^(?:ATLAS|BIRCH|CEDAR)-[A-Z0-9-]{1,48}$/;
export function validDate(value: string): boolean {
  if (!/^[0-9]{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)),
    month = Number(value.slice(4, 6)),
    day = Number(value.slice(6, 8));
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1) return false;
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= days[month - 1]!;
}
export function validTime(value: string): boolean {
  return (
    /^[0-9]{8}-(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{3})?$/.test(value) &&
    validDate(value.slice(0, 8))
  );
}
function quantity(value: string, minimum: bigint): bigint {
  if (!/^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/.test(value)) fail('INVALID_VALUE');
  const cents = BigInt(value.replace('.', ''));
  if (cents < minimum || cents > 100000000000n) fail('INVALID_VALUE');
  return cents;
}
function positivePrice(value: string): boolean {
  return /^(?:0|[1-9][0-9]{0,4})\.[0-9]{12}$/.test(value) && BigInt(value.replace('.', '')) > 0n;
}
export function validateProfile(f: FixFields): { type: MessageType; direction: Direction } {
  for (const tag of ['35', '49', '56', '34', '52']) if (!f[tag]) fail('MISSING_FIELD');
  if (!/^[1-9][0-9]{0,9}$/.test(f['34']!) || BigInt(f['34']!) > 2147483647n || !validTime(f['52']!))
    fail('INVALID_VALUE');
  if (f['43'] !== undefined && f['43'] !== 'Y' && f['43'] !== 'N') fail('INVALID_VALUE');
  if (f['43'] === 'Y') {
    if (
      !f['122'] ||
      !validTime(f['122']) ||
      f['122'].padEnd(21, '.000') > f['52']!.padEnd(21, '.000')
    )
      fail('INVALID_VALUE');
  } else if (f['122'] !== undefined) fail('INVALID_VALUE');
  const type = f['35'];
  if (type !== 'D' && type !== '8' && type !== 'F' && type !== '9') fail('UNSUPPORTED_MESSAGE');
  const profile = PROFILES[type];
  const allowed = new Set<string>([...HEADER, ...profile.order]);
  for (const tag of Object.keys(f)) if (!allowed.has(tag)) fail('UNSUPPORTED_FIELD');
  for (const tag of ['35', '49', '56', '34', '52', ...profile.required])
    if (!f[tag]) fail('MISSING_FIELD');
  const outbound = type === 'D' || type === 'F';
  const dealer = outbound ? f['56']! : f['49']!;
  if (!['ATLAS', 'BIRCH', 'CEDAR'].includes(dealer) || f[outbound ? '49' : '56'] !== 'TRADEFLOW')
    fail('INVALID_VALUE');
  for (const tag of ['11', '41'])
    if (f[tag] !== undefined && !uuid.test(f[tag])) fail('INVALID_VALUE');
  if (f['41'] !== undefined && f['11'] === f['41']) fail('INVALID_VALUE');
  for (const tag of ['37', '17'])
    if (f[tag] !== undefined && (!dealerId.test(f[tag]) || !f[tag].startsWith(dealer + '-')))
      fail('INVALID_VALUE');
  if (!validTime(f['60']!)) fail('INVALID_VALUE');
  if (f['75'] !== undefined && (!validDate(f['75']) || f['75'] !== f['60']!.slice(0, 8)))
    fail('INVALID_VALUE');
  if (
    f['58'] !== undefined &&
    !['SYNTHETIC_REJECTION', 'SYNTHETIC_CANCEL_REJECT', 'SYNTHETIC_CANCEL_REQUEST'].includes(
      f['58'],
    )
  )
    fail('INVALID_VALUE');
  if (type !== '9') {
    if (!['1', '2'].includes(f['54']!)) fail('INVALID_VALUE');
    if (!(
      (f['55'] === 'SYN-UST-2031' && f['167'] === 'TNOTE') ||
      (f['55'] === 'SYN-CORP-2031' && f['167'] === 'CORP')
    ))
      fail('INVALID_VALUE');
    quantity(f['38']!, 100n);
  }
  if (type === 'D' || type === '8') {
    if (
      f['854'] !== '0' ||
      f['40'] !== '2' ||
      f['59'] !== '1' ||
      f['423'] !== '1' ||
      f['15'] !== 'USD' ||
      !positivePrice(f['44']!)
    )
      fail('INVALID_VALUE');
    if (!validDate(f['64']!) || f['64']! < '20250115' || f['64']! >= '20310115')
      fail('INVALID_VALUE');
  }
  if (type === '8') {
    const exec = f['150']!,
      status = f['39']!;
    if (!['0', '8', 'F', '6', '4'].includes(exec)) fail('UNSUPPORTED_VALUE');
    const q = quantity(f['38']!, 100n),
      cum = quantity(f['14']!, 0n),
      leaves = quantity(f['151']!, 0n);
    if (cum > q || leaves > q || f['6'] !== (cum === 0n ? '0.000000000000' : f['44']))
      fail('INVALID_VALUE');
    if (exec === 'F') {
      if (f['32'] === undefined || f['31'] === undefined) fail('MISSING_FIELD');
      const last = quantity(f['32'], 1n);
      if (
        last > cum ||
        f['31'] !== f['44'] ||
        f['41'] !== undefined ||
        cum === 0n ||
        leaves !== q - cum ||
        !['1', '2', '6'].includes(status) ||
        (status === '1' && cum === q) ||
        (status === '2' && cum !== q)
      )
        fail('INVALID_VALUE');
    } else {
      if (f['32'] !== undefined || f['31'] !== undefined) fail('INVALID_VALUE');
      if (status !== exec) fail('INVALID_VALUE');
      if (
        (exec === '0' && (cum !== 0n || leaves !== q)) ||
        (exec === '8' && (cum !== 0n || leaves !== 0n)) ||
        (exec === '4' && (leaves !== 0n || cum === q)) ||
        (exec === '6' && leaves !== q - cum)
      )
        fail('INVALID_VALUE');
      if (exec === '6' || exec === '4') {
        if (!f['41']) fail('MISSING_FIELD');
      } else if (f['41'] !== undefined) fail('INVALID_VALUE');
    }
    if (exec === '8') {
      if (f['103'] === undefined) fail('MISSING_FIELD');
      if (!['6', '99'].includes(f['103'])) fail('UNSUPPORTED_VALUE');
    } else if (f['103'] !== undefined) fail('INVALID_VALUE');
  }
  if (type === '9') {
    if (f['434'] !== '1' || !['0', '1', '2'].includes(f['39']!) || !['0', '99'].includes(f['102']!))
      fail('INVALID_VALUE');
    if ((f['102'] === '0') !== (f['39'] === '2')) fail('INVALID_VALUE');
  }
  return { type, direction: outbound ? 'CLIENT_TO_DEALER' : 'DEALER_TO_CLIENT' };
}
