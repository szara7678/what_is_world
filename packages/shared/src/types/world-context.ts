export type Weather = "sunny" | "cloudy" | "rain" | "fog" | "windy";

export interface WorldContext {
  weather: Weather;
  weatherUntilTick: number;
  marketDayActive: boolean;
  marketDayUntilTick: number;
  activeIssue?: {
    kind: "well_dry" | "boar_pack" | "low_harvest" | "harvest_festival" | "traveler_arrival";
    until: number;
    text: string;
  };
  nextHarvestFestivalDay?: number;
  nextTravelerArrivalDay?: number;
  travelerActorId?: string;
  travelerUntilDay?: number;
  /** Spec stage 1: 작물 황금기. 매 day 새벽에 8-12% 확률 발동, duration 2-3일, cooldown 5+일.
   *  yieldMul (기본 1.5) 이 gather 결과 수량에 곱함. 종료 시 observation 으로 흐르고 broadcast X. */
  harvestSeason?: {
    crops: string[];          // ["wheat"] / ["apple", "berry"]
    yieldMul: number;         // 1.5 권장
    startedAtTick: number;
    untilTick: number;
    nextEarliestTick: number; // cooldown 종료 시각 (다음 발동 가능 시각)
    mood: "abundant" | "bountiful";
  };
  resources: {
    carrotStock: number;
    wellWaterLevel: number;
  };
  calendarDay: number;
}

export const createDefaultWorldContext = (tick = 0): WorldContext => ({
  weather: "sunny",
  weatherUntilTick: tick + 360,
  marketDayActive: false,
  marketDayUntilTick: 0,
  resources: {
    carrotStock: 6,
    wellWaterLevel: 10
  },
  calendarDay: Math.floor(tick / 1440)
});
