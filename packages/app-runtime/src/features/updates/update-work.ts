let active = 0;
let locked = false;
export function beginUpdateWork(): () => void {
  if (locked)
    throw new Error(
      "An update is being installed. Try again after it finishes.",
    );
  active++;
  let finished = false;
  return () => {
    if (!finished) {
      finished = true;
      active--;
    }
  };
}
export function lockUpdateWork(): boolean {
  if (active) return false;
  locked = true;
  return true;
}
export function unlockUpdateWork() {
  locked = false;
}
