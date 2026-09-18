// api/alert.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { region } = req.query;
  if (!region) return res.status(400).json({ error: 'region 파라미터가 필요합니다.' });

  const SERVICE_KEY = process.env.KMA_API_KEY;
  if (!SERVICE_KEY) return res.status(200).json({ type: 'none' }); // 키 없으면 조용히 none

  // 지역 코드: 앞 4자리가 행정구역 코드 prefix
  const REGION_CODES = {
    '서울':  ['1100'],
    '경기':  ['4100'],
    '인천':  ['2300'],
    '충남':  ['4400', '3000'],
    '충북':  ['4300'],
    '전북':  ['4500'],
    '전남':  ['4600', '2900'],
    '강원':  ['4200'],
    '경북':  ['4700', '2700'],
    '경남':  ['4800', '2600', '3100'],
    '제주':  ['5000'],
  };

  const codes = REGION_CODES[region];
  if (!codes) return res.status(200).json({ type: 'none' });

  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

    const url = new URL('http://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnList');
    url.searchParams.set('serviceKey', SERVICE_KEY);
    url.searchParams.set('pageNo', '1');
    url.searchParams.set('numOfRows', '100');
    url.searchParams.set('dataType', 'JSON');
    url.searchParams.set('fromTmFc', today + '0000');
    url.searchParams.set('toTmFc',   today + '2359');

    const apiRes = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });
    if (!apiRes.ok) return res.status(200).json({ type: 'none' });

    const json  = await apiRes.json();
    const items = json?.response?.body?.items?.item ?? [];

    // items가 단일 객체로 올 수도 있음 (기상청 API quirk)
    const list = Array.isArray(items) ? items : [items];

    let alertType = 'none';

    for (const item of list) {
      // stnId를 문자열로 안전하게 변환 후 앞 4자리 비교
      const stnIdStr = String(item.stnId ?? '').padStart(10, '0');
      const isTargetRegion = codes.some(prefix => stnIdStr.startsWith(prefix));
      if (!isTargetRegion) continue;

      // 폭염 관련 특보만 필터
      const wrnText = String(item.wrn ?? '') + String(item.wrnVar ?? '');
      if (!wrnText.includes('폭염') && !wrnText.includes('열')) continue;

      // tmCn(해제시각)이 있으면 이미 해제된 특보
      const isActive = !item.tmCn || String(item.tmCn).trim() === '';
      if (!isActive) continue;

      const lvl = String(item.wrnLvl ?? item.wrn ?? '');

      if (lvl.includes('중대경보'))      { alertType = 'critical'; break; }
      else if (lvl.includes('경보'))     { if (alertType !== 'critical') alertType = 'warning'; }
      else if (lvl.includes('주의보'))   { if (alertType === 'none') alertType = 'watch'; }
    }

    return res.status(200).json({ type: alertType });

  } catch (err) {
    console.error('[alert] error:', err);
    return res.status(200).json({ type: 'none' }); // 특보는 실패해도 none으로 조용히 처리
  }
}
