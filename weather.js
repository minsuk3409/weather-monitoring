// Vercel 서버리스 함수
// 브라우저 → 이 함수 → 기상청 API (CORS 우회)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { nx, ny, type, curFeels } = req.query;

  const API_KEY = process.env.KMA_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const pad = (n) => String(n).padStart(2, '0');

  let baseDate = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  let baseTime, endpoint;
  let numOfRows = '100';

  if (type === 'current') {
    // 초단기실황: 매시 45분 이후에 당시간 데이터가 확정됨
    const minutesPast = now.getHours() * 60 + now.getMinutes();
    let hour;
    if (now.getMinutes() < 45) {
      hour = now.getHours() - 1;
    } else {
      hour = now.getHours();
    }
    // 자정 직후 (00시 45분 이전) 예외 처리
    if (hour < 0) {
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      baseDate = `${yesterday.getFullYear()}${pad(yesterday.getMonth() + 1)}${pad(yesterday.getDate())}`;
      hour = 23;
    }
    baseTime = `${pad(hour)}00`;
    endpoint = 'getUltraSrtNcst';

  } else {
    // 단기예보: 발표 시각 목록 = 02,05,08,11,14,17,20,23시
    // 현재 시각보다 이전의 가장 최근 발표 시각을 선택
    const FCST_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
    const currentHour = now.getHours();
    const currentMin  = now.getMinutes();

    // 발표 후 약 10분 뒤부터 데이터가 안정적으로 제공되므로 10분 여유를 둠
    let selectedHour = null;
    for (let i = FCST_HOURS.length - 1; i >= 0; i--) {
      const fh = FCST_HOURS[i];
      if (currentHour > fh || (currentHour === fh && currentMin >= 10)) {
        selectedHour = fh;
        break;
      }
    }

    if (selectedHour === null) {
      // 아직 당일 02:10 이전이면 전날 23시 발표본 사용
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      baseDate = `${yesterday.getFullYear()}${pad(yesterday.getMonth() + 1)}${pad(yesterday.getDate())}`;
      selectedHour = 23;
    }

    baseTime = `${pad(selectedHour)}00`;
    endpoint = 'getVilageFcst';
    numOfRows = '1000';
  }

  const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/${endpoint}?serviceKey=${API_KEY}&numOfRows=${numOfRows}&pageNo=1&dataType=JSON&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return res.status(502).json({ error: `기상청 API 오류: ${response.status}` });
    }
    const data = await response.json();

    // 기상청 API 자체 오류 코드 확인
    const resultCode = data?.response?.header?.resultCode;
    if (resultCode && resultCode !== '00') {
      const resultMsg = data?.response?.header?.resultMsg ?? '알 수 없는 오류';
      return res.status(502).json({ error: `기상청 오류 [${resultCode}]: ${resultMsg}` });
    }

    const items = data?.response?.body?.items?.item ?? [];

    if (type === 'current') {
      const find = (cat) => items.find(i => i.category === cat)?.obsrValue;
      const temp     = parseFloat(find('T1H') ?? 'NaN');
      const humidity = parseFloat(find('REH') ?? 'NaN');
      const wind     = parseFloat(find('WSD') ?? 'NaN');
      const pty      = find('PTY') ?? '0';

      // 값이 없으면 null로 명시
      if (isNaN(temp)) {
        return res.status(200).json({ temp: null, feelsLike: null, humidity: null, wind: null, pty: '0', baseDate, baseTime });
      }

      const feelsLike = Math.round(calcFeelsLike(temp, isNaN(humidity) ? 60 : humidity, isNaN(wind) ? 1 : wind) * 10) / 10;

      return res.status(200).json({
        temp,
        feelsLike,
        humidity: isNaN(humidity) ? null : humidity,
        wind:     isNaN(wind)     ? null : wind,
        pty,
        baseDate,
        baseTime,
      });

    } else {
      const today = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const tmx = items.find(i => i.category === 'TMX' && i.fcstDate === today)?.fcstValue;
      const tmn = items.find(i => i.category === 'TMN' && i.fcstDate === today)?.fcstValue;

      const hourlyT   = items.filter(i => i.category === 'TMP' && i.fcstDate === today);
      const hourlyW   = items.filter(i => i.category === 'WSD' && i.fcstDate === today);
      const hourlyREH = items.filter(i => i.category === 'REH' && i.fcstDate === today);

      const allFeelsLikeValues = [];

      // 프론트에서 넘어온 실측 체감온도 추가
      if (curFeels !== undefined && curFeels !== null && curFeels !== '') {
        const parsed = parseFloat(curFeels);
        if (!isNaN(parsed)) allFeelsLikeValues.push(parsed);
      }

      // 시간대별 예보 체감온도 계산
      for (const t of hourlyT) {
        const time = t.fcstTime;
        const tmp  = parseFloat(t.fcstValue);
        const wsd  = parseFloat(hourlyW.find(w => w.fcstTime === time)?.fcstValue ?? '1');
        const reh  = parseFloat(hourlyREH.find(r => r.fcstTime === time)?.fcstValue ?? '60');
        if (!isNaN(tmp)) {
          allFeelsLikeValues.push(calcFeelsLike(tmp, isNaN(reh) ? 60 : reh, isNaN(wsd) ? 1 : wsd));
        }
      }

      const feelsMax = allFeelsLikeValues.length ? Math.round(Math.max(...allFeelsLikeValues) * 10) / 10 : null;
      const feelsMin = allFeelsLikeValues.length ? Math.round(Math.min(...allFeelsLikeValues) * 10) / 10 : null;

      return res.status(200).json({
        tempMax:  tmx != null ? parseFloat(tmx) : null,
        tempMin:  tmn != null ? parseFloat(tmn) : null,
        feelsMax,
        feelsMin,
        baseDate,
        baseTime,
      });
    }
  } catch (err) {
    console.error('[weather] error:', err);
    // timeout 구분
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: '기상청 API 응답 시간 초과' });
    }
    return res.status(500).json({ error: err.message });
  }
}

// 체감온도 계산 공통 함수
function calcFeelsLike(temp, humidity, wind) {
  if (temp >= 10) {
    // 열지수(Heat Index)
    const h = humidity / 100;
    const hi = -8.784695
      + 1.61139411 * temp
      + 2.338549   * h
      - 0.14611605 * temp * h
      - 0.01230809 * (temp ** 2)
      - 0.01642482 * (h ** 2)
      + 0.00221173 * (temp ** 2) * h
      + 0.00072546 * temp * (h ** 2)
      - 0.00000358 * (temp ** 2) * (h ** 2);
    return hi > temp ? hi : temp;
  } else {
    // 바람 냉각 지수(Wind Chill)
    const v016 = Math.pow(Math.max(wind, 0) * 3.6, 0.16);
    return 13.12 + 0.6215 * temp - 11.37 * v016 + 0.3965 * v016 * temp;
  }
}
