// Timestamped logger. Keeps console.log output identical to the original
// monolithic implementation so external log scrapers stay compatible.
export function log(...args) {
  console.log(new Date().toISOString(), ...args)
}
