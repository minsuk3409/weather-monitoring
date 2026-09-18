// api/alert.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { region } = req.query;
  if (!region) return res.status(400).json({ error: 'region 파라미터가 필요합니다.' });

  const SERVICE_KEY = process.env.KMA_API_KEY;
  if (!SERVICE_KEY) return res.status(200).json({ alerts: [] });

  const REGION_CODES = {
    '서울': ['1100'], '경기': ['4100'], '인천': ['2300'], '충남': ['4400', '3000'],
    '충북': ['4300'], '전북': ['4500'], '전남': ['4600', '2900'], '강원': ['4200'],
    '경북': ['4700', '2700'], '경남': ['4800', '2600', '3100'], '제주': ['5000'],
  };

  const codes = REGION_CODES[region];
  if (!codes) return res.status(200).json({ alerts: [] });

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
    url.searchParams.set('toTmFc', today + '2359');

    const apiRes = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });
    if (!apiRes.ok) return res.status(200).json({ alerts: [] });

    const json = await apiRes.json();
    const items = json?.response?.body?.items?.item ?? [];
    const list = Array.isArray(items) ? items : [items];

    const alerts = [];

    for (const item of list) {
      const stnIdStr = String(item.stnId ?? '').padStart(10, '0');
      const isTargetRegion = codes.some(prefix => stnIdStr.startsWith(prefix));
      if (!isTargetRegion) continue;

      const isActive = !item.tmCn || String(item.tmCn).trim() === '';
      if (!isActive) continue;

      const wrnText = String(item.wrn ?? '') + String(item.wrnVar ?? '');
      const lvl = String(item.wrnLvl ?? item.wrn ?? '');

      let levelStr = '주의보';
      if (lvl.includes('중대경보')) levelStr = '중대경보';
      else if (lvl.includes('경보')) levelStr = '경보';

      // 특보 종류 판별
      const types = ['폭염', '한파', '호우', '강풍', '풍랑', '태풍', '대설', '건조', '황사'];
      for (const t of types) {
        if (wrnText.includes(t)) {
          alerts.push({ type: t, level: levelStr });
        }
      }
    }

    return res.status(200).json({ alerts });

  } catch (err) {
    console.error('[alert] error:', err);
    return res.status(200).json({ alerts: [] });
  }
}
