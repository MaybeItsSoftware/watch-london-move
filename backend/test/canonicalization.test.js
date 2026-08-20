const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { canonicalizeStationName } = require('../src/canonicalization');

describe('canonicalizeStationName', () => {
  it('expands the abbreviations the feed uses', () => {
    assert.equal(canonicalizeStationName('Heathrow', 'piccadilly'), 'Heathrow Terminals 1, 2, 3 Station');
    assert.equal(canonicalizeStationName('Warwick Ave', 'bakerloo'), 'Warwick Avenue Station');
  });

  it('strips the platform suffix', () => {
    assert.equal(canonicalizeStationName('Bank Platform 3', 'central'), 'Bank Station');
  });

  it('restores apostrophes the feed drops', () => {
    assert.equal(canonicalizeStationName('Earls Court', 'district'), "Earl's Court Station");
    assert.equal(canonicalizeStationName('Regents Park', 'bakerloo'), "Regent's Park Station");
  });

  // Edgware Road is two distinct stations with one name, so the line is the
  // only thing that can tell them apart.
  it('disambiguates Edgware Road by line', () => {
    assert.equal(canonicalizeStationName('Edgware Road', 'bakerloo'), 'Edgware Road Bakerloo Station');
    assert.equal(canonicalizeStationName('Edgware Road', 'circle'), 'Edgware Road Circle Station');
  });

  it('does not append "Station" to modes that do not have them', () => {
    assert.equal(canonicalizeStationName('Wimbledon', 'tram'), 'Wimbledon');
    assert.equal(canonicalizeStationName('Canary Wharf', 'dlr'), 'Canary Wharf');
    // Overground was split into six named lines in 2024; each must be recognised.
    assert.equal(canonicalizeStationName('Dalston Junction', 'windrush'), 'Dalston Junction');
  });

  it('does not double up an existing suffix', () => {
    assert.equal(canonicalizeStationName('Victoria Station', 'victoria'), 'Victoria Station');
  });

  it('tolerates an empty name', () => {
    assert.equal(canonicalizeStationName('', 'tram'), '');
  });
});
