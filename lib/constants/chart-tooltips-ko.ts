const INDICATOR_TOOLTIP_KO: Record<string, string> = {
  US10Y: '미국 10년 국채금리입니다. 장기 성장·인플레이션 기대와 할인율 변화를 반영합니다.',
  US2Y: '미국 2년 국채금리입니다. 연준 정책금리 기대를 가장 빠르게 반영하는 구간입니다.',
  T10Y2Y: '미국 장단기 금리차입니다. 경기침체 우려와 정책 전환 기대를 점검하는 핵심 지표입니다.',
  DXY: '달러 인덱스입니다. 글로벌 달러 강세/약세와 위험자산 압력을 함께 보여줍니다.',
  HYS: '하이일드 스프레드입니다. 신용위험 프리미엄 확대로 금융 스트레스 여부를 확인합니다.',
  M2: '미국 통화량(M2)입니다. 유동성 환경과 중기 자산가격 압력 판단에 사용됩니다.',
  CPI: '미국 소비자물가지수입니다. 인플레이션 경로와 통화정책 방향의 핵심 근거입니다.',
  PAYEMS: '미국 비농업 고용자수입니다. 경기의 체력과 소비 여력을 보여주는 고용 핵심 지표입니다.',
  SPX: 'S&P 500 지수입니다. 미국 대형주 전반의 위험선호와 실적 기대를 반영합니다.',
  IXIC: '나스닥 종합지수입니다. 성장주·기술주 중심의 금리 민감도를 확인할 수 있습니다.',
  RUT: '러셀 2000 지수입니다. 중소형주 기반의 내수 경기 민감도를 보여줍니다.',
  OIL: 'WTI 유가입니다. 인플레이션 압력과 글로벌 수요/공급 충격을 함께 반영합니다.',
  GOLD: '금 가격입니다. 실질금리와 안전자산 선호 변화를 확인할 수 있습니다.',
  'Cu/Au': '구리/금 비율입니다. 경기민감 자산 대비 안전자산 선호 변화를 보여줍니다.',
  BTC: '비트코인 가격입니다. 유동성·위험선호·시장 레버리지 변화를 민감하게 반영합니다.',
  VIX: 'VIX 지수입니다. 옵션시장의 변동성 기대치로 단기 공포 수준을 점검합니다.',
  MOVE: 'MOVE 지수입니다. 미국 채권시장의 금리 변동성 스트레스를 보여줍니다.',
  USDKRW: '원/달러 환율입니다. 대외 리스크와 외국인 자금 흐름 민감도를 반영합니다.',
  KOSPI: '코스피 지수입니다. 한국 대형주 중심의 경기·수출 기대를 반영합니다.',
  EWY: '미국 상장 한국 ETF(EWY)입니다. 해외 투자자의 한국시장 평가를 추적합니다.',
  KOSDAQ: '코스닥 지수입니다. 성장주·중소형주 위험선호와 국내 유동성을 보여줍니다.',
  KR3Y: '한국 3년물 국채 프록시입니다. 국내 단기 금리 기대와 정책 민감도를 반영합니다.',
  KR10Y: '한국 10년물 국채 프록시입니다. 장기 성장/물가 기대와 위험 프리미엄을 반영합니다.',
  KRSEMI: '한국 반도체 프록시 지표입니다. 메모리 사이클과 수출 모멘텀 변화를 보여줍니다.',
  KRTB: '한국 무역수지 지표입니다. 대외수요와 환율 환경이 실물경제에 미치는 영향을 보여줍니다.',
  MFG: '제조업 심리지수입니다. 경기 선행 국면과 기업 체감 경기를 점검하는 지표입니다.',
};

const INDICATOR_LABEL_KO: Record<string, string> = {
  US10Y: '미국 10년금리',
  US2Y: '미국 2년금리',
  T10Y2Y: '장단기 금리차',
  DXY: '달러지수',
  HYS: '하이일드 스프레드',
  M2: 'M2 통화량',
  CPI: '미국 CPI',
  PAYEMS: '미국 고용',
  SPX: 'S&P 500',
  IXIC: '나스닥',
  RUT: '러셀 2000',
  OIL: 'WTI 유가',
  GOLD: '금',
  'Cu/Au': '구리/금 비율',
  BTC: '비트코인',
  VIX: 'VIX',
  MOVE: 'MOVE',
  USDKRW: '원/달러',
  KOSPI: '코스피',
  EWY: 'EWY',
  KOSDAQ: '코스닥',
  KR3Y: '한국 3년물',
  KR10Y: '한국 10년물',
  KRSEMI: '한국 반도체',
  KRTB: '한국 무역수지',
  MFG: '제조업 심리',
};

export const ADVANCED_ANALYTICS_CHART_TOOLTIP_KO: Record<string, string> = {
  periodComparison: '지표별 단기/중기/장기 변화율을 동시에 비교해 모멘텀 전환 여부를 확인합니다.',
  volatilityTrend: '변동성(리스크 크기)과 추세점수(방향성 강도)를 함께 비교해 시장 국면을 읽습니다.',
};

export function getIndicatorTooltipKo(symbol: string, fallbackName?: string): string {
  return INDICATOR_TOOLTIP_KO[symbol] || `${fallbackName || symbol} 지표입니다.`;
}

export function getIndicatorLabelKo(symbol: string, fallbackLabel = '지표'): string {
  return INDICATOR_LABEL_KO[symbol] || fallbackLabel;
}
