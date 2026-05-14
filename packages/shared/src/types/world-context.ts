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
