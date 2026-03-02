import { DashboardData } from '../types/indicators';

export type DashboardIndicatorKey = keyof DashboardData['indicators'];

export interface IndicatorGroupItem {
  indicatorKey: DashboardIndicatorKey;
  commentKey: string;
}

export interface IndicatorGroupConfig {
  id: string;
  title: string;
  description: string;
  items: IndicatorGroupItem[];
}

export const INDICATOR_GROUPS: IndicatorGroupConfig[] = [
  {
    id: 'macro',
    title: '매크로 지표',
    description: '금리, 달러, 신용, 통화, 물가, 고용의 경기 방향 신호',
    items: [
      { indicatorKey: 'us10yYield', commentKey: 'US10Y' },
      { indicatorKey: 'us2yYield', commentKey: 'US2Y' },
      { indicatorKey: 'yieldCurveSpread', commentKey: 'T10Y2Y' },
      { indicatorKey: 'dxy', commentKey: 'DXY' },
      { indicatorKey: 'highYieldSpread', commentKey: 'HYS' },
      { indicatorKey: 'm2MoneySupply', commentKey: 'M2' },
      { indicatorKey: 'cpi', commentKey: 'CPI' },
      { indicatorKey: 'payems', commentKey: 'PAYEMS' },
    ],
  },
  {
    id: 'equity',
    title: '미국 주식시장',
    description: '대형주/기술주/중소형주 위험선호 흐름',
    items: [
      { indicatorKey: 'sp500', commentKey: 'SPX' },
      { indicatorKey: 'nasdaq', commentKey: 'IXIC' },
      { indicatorKey: 'russell2000', commentKey: 'RUT' },
    ],
  },
  {
    id: 'commodities',
    title: '원자재·대체자산',
    description: '에너지, 귀금속, 경기민감 금속, 디지털 자산 흐름',
    items: [
      { indicatorKey: 'crudeOil', commentKey: 'OIL' },
      { indicatorKey: 'gold', commentKey: 'GOLD' },
      { indicatorKey: 'copperGoldRatio', commentKey: 'Cu/Au' },
      { indicatorKey: 'bitcoin', commentKey: 'BTC' },
    ],
  },
  {
    id: 'risk',
    title: '리스크 민감 지표',
    description: '주식·금리 변동성 기반 시장 스트레스 신호',
    items: [
      { indicatorKey: 'putCallRatio', commentKey: 'VIX' },
      { indicatorKey: 'moveIndex', commentKey: 'MOVE' },
    ],
  },
  {
    id: 'korea-related',
    title: '한국 연계 지표',
    description: '환율·주식·해외상장 한국 ETF 흐름',
    items: [
      { indicatorKey: 'usdKrw', commentKey: 'USDKRW' },
      { indicatorKey: 'kospi', commentKey: 'KOSPI' },
      { indicatorKey: 'ewy', commentKey: 'EWY' },
    ],
  },
  {
    id: 'korea-specialized',
    title: '한국 특화 지표',
    description: '코스닥·국채 프록시·반도체·무역 흐름',
    items: [
      { indicatorKey: 'kosdaq', commentKey: 'KOSDAQ' },
      { indicatorKey: 'kr3yBond', commentKey: 'KR3Y' },
      { indicatorKey: 'kr10yBond', commentKey: 'KR10Y' },
      { indicatorKey: 'koreaSemiconductorExportsProxy', commentKey: 'KRSEMI' },
      { indicatorKey: 'koreaTradeBalance', commentKey: 'KRTB' },
    ],
  },
  {
    id: 'sentiment',
    title: '경기 심리',
    description: '제조업 심리 기반 경기 국면 확인',
    items: [{ indicatorKey: 'pmi', commentKey: 'MFG' }],
  },
];
