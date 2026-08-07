// London Overground was split into six named lines in 2024; `london-overground`
// is no longer a valid TfL line id and returns 404.
const OVERGROUND_LINE_IDS = ['lioness', 'mildmay', 'windrush', 'weaver', 'suffragette', 'liberty'];

function isOvergroundLine(lineId) {
  return OVERGROUND_LINE_IDS.includes(lineId);
}

function vehicleTypeForLine(lineId) {
  return isOvergroundLine(lineId) ? 'overground' : lineId;
}

module.exports = {
  OVERGROUND_LINE_IDS,
  isOvergroundLine,
  vehicleTypeForLine,
};
