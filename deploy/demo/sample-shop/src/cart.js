/** A cart: what is in it, by product id, with the price each was added at. */
export function createCart() {
  return { items: new Map() };
}

export function addItem(cart, { id, name, priceCents }, quantity = 1) {
  const line = cart.items.get(id);
  if (line) line.quantity += quantity;
  else cart.items.set(id, { id, name, priceCents, quantity });
  return cart;
}

export function removeItem(cart, id) {
  cart.items.delete(id);
  return cart;
}

export function itemCount(cart) {
  let count = 0;
  for (const line of cart.items.values()) count += line.quantity;
  return count;
}

export function subtotalCents(cart) {
  let total = 0;
  for (const line of cart.items.values()) total += line.priceCents * line.quantity;
  return total;
}
