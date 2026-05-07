export interface SubwayStation {
  name: string;
  line: 'M1' | 'M2';
  lat: number;
  lng: number;
}

// Trim/extend as needed. Coordinates are WGS84.
export const WARSAW_SUBWAY_STATIONS: SubwayStation[] = [
  // M1
  { name: 'Kabaty',           line: 'M1', lat: 52.1268, lng: 21.0397 },
  { name: 'Natolin',          line: 'M1', lat: 52.1396, lng: 21.0440 },
  { name: 'Imielin',          line: 'M1', lat: 52.1492, lng: 21.0465 },
  { name: 'Stokłosy',         line: 'M1', lat: 52.1567, lng: 21.0490 },
  { name: 'Ursynów',          line: 'M1', lat: 52.1641, lng: 21.0509 },
  { name: 'Służew',           line: 'M1', lat: 52.1773, lng: 21.0299 },
  { name: 'Wilanowska',       line: 'M1', lat: 52.1825, lng: 21.0276 },
  { name: 'Wierzbno',         line: 'M1', lat: 52.1901, lng: 21.0211 },
  { name: 'Racławicka',       line: 'M1', lat: 52.1955, lng: 21.0186 },
  { name: 'Pole Mokotowskie', line: 'M1', lat: 52.2069, lng: 21.0143 },
  { name: 'Politechnika',     line: 'M1', lat: 52.2200, lng: 21.0146 },
  { name: 'Centrum',          line: 'M1', lat: 52.2298, lng: 21.0118 },
  { name: 'Świętokrzyska',    line: 'M1', lat: 52.2356, lng: 21.0103 },
  { name: 'Ratusz Arsenał',   line: 'M1', lat: 52.2453, lng: 21.0033 },
  { name: 'Dworzec Gdański',  line: 'M1', lat: 52.2566, lng: 20.9967 },
  { name: 'Plac Wilsona',     line: 'M1', lat: 52.2698, lng: 20.9843 },
  { name: 'Marymont',         line: 'M1', lat: 52.2782, lng: 20.9781 },
  { name: 'Słodowiec',        line: 'M1', lat: 52.2868, lng: 20.9676 },
  { name: 'Stare Bielany',    line: 'M1', lat: 52.2939, lng: 20.9533 },
  { name: 'Wawrzyszew',       line: 'M1', lat: 52.2986, lng: 20.9466 },
  { name: 'Młociny',          line: 'M1', lat: 52.2906, lng: 20.9305 },

  // M2 (current operating segment)
  { name: 'Bemowo',           line: 'M2', lat: 52.2469, lng: 20.9106 },
  { name: 'Ulrychów',         line: 'M2', lat: 52.2438, lng: 20.9300 },
  { name: 'Księcia Janusza',  line: 'M2', lat: 52.2389, lng: 20.9486 },
  { name: 'Młynów',           line: 'M2', lat: 52.2371, lng: 20.9657 },
  { name: 'Płocka',           line: 'M2', lat: 52.2330, lng: 20.9759 },
  { name: 'Rondo Daszyńskiego', line: 'M2', lat: 52.2316, lng: 20.9866 },
  { name: 'Rondo ONZ',        line: 'M2', lat: 52.2334, lng: 20.9971 },
  { name: 'Świętokrzyska',    line: 'M2', lat: 52.2356, lng: 21.0103 },
  { name: 'Nowy Świat',       line: 'M2', lat: 52.2375, lng: 21.0205 },
  { name: 'Centrum Nauki Kopernik', line: 'M2', lat: 52.2410, lng: 21.0291 },
  { name: 'Stadion Narodowy', line: 'M2', lat: 52.2483, lng: 21.0441 },
  { name: 'Dworzec Wileński', line: 'M2', lat: 52.2546, lng: 21.0354 },
  { name: 'Szwedzka',         line: 'M2', lat: 52.2618, lng: 21.0448 },
  { name: 'Targówek Mieszkaniowy', line: 'M2', lat: 52.2778, lng: 21.0588 },
  { name: 'Trocka',           line: 'M2', lat: 52.2823, lng: 21.0651 },
];
