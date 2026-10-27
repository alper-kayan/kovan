import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem, createCart, itemCount, removeItem, subtotalCents } from '../src/cart.js';
import { formatPrice } from '../src/money.js';

const mug = { id: 'mug', name: 'Mug', priceCents: 1200 };
const tea = { id: 'tea', name: 'Green tea', priceCents: 850 };

test('adding the same item again raises its quantity', () => {
  const cart = addItem(addItem(createCart(), mug), mug, 2);
  assert.equal(itemCount(cart), 3);
  assert.equal(subtotalCents(cart), 3600);
});

test('removing an item takes all of it out', () => {
  const cart = addItem(addItem(createCart(), mug), tea);
  removeItem(cart, 'mug');
  assert.equal(itemCount(cart), 1);
  assert.equal(subtotalCents(cart), 850);
});

test('prices read as dollars and cents', () => {
  assert.equal(formatPrice(1999), '$19.99');
  assert.equal(formatPrice(5), '$0.05');
  assert.equal(formatPrice(-250), '-$2.50');
});
