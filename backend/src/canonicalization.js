const STATION_REPLACEMENTS = [
  [/^Heathrow$/, 'Heathrow Terminals 1, 2, 3'],
  [/^Olympia$/, 'Kensington (Olympia)'],
  [/^Warwick Ave$/, 'Warwick Avenue'],
  [/^Camden$/, 'Camden Town'],
  [/Notting Hill Ga$/, 'Notting Hill Gate'],
  [/High Street Kensingt$/, 'High Street Kensington'],
  [/\s*Platform \d+$/, ''],
];

const STRING_REPLACEMENTS = [
  ['Camden Town (20B-20A)', 'Camden Town'],
  ['Camden Town at Point 20A', 'Camden Town'],
  ['(Bakerloo)', 'Bakerloo'],
  ['Earls', "Earl's"],
  ['St ', 'St. '],
  ['Warren St.', 'Warren Street'],
  ['Elephant and Castle', 'Elephant & Castle'],
  ['South Fields', 'Southfields'],
  ['Regents Park', "Regent's Park"],
  ['St. Johns Wood', "St. John's Wood"],
  ['St. John Wood', "St. John's Wood"],
  ['Moor park', 'Moor Park'],
  ['Harrow-on-the-Hill', 'Harrow on the Hill'],
];

function canonicalizeStationName(input, line) {
  let station = (input || '').trim();
  STATION_REPLACEMENTS.forEach(([pattern, replacement]) => {
    station = station.replace(pattern, replacement);
  });
  STRING_REPLACEMENTS.forEach(([from, to]) => {
    station = station.replaceAll(from, to);
  });

  if (!station.endsWith('Station') && !['tram', 'dlr', 'london-overground', 'elizabeth'].includes(line)) {
    station = `${station} Station`;
  }

  if (station === 'Edgware Road Station') {
    return line === 'bakerloo' ? 'Edgware Road Bakerloo Station' : 'Edgware Road Circle Station';
  }

  return station;
}

module.exports = {
  canonicalizeStationName,
};
