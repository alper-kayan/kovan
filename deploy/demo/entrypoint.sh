#!/bin/sh
# The demo machine's checkout: the sample shop, made once into a git repository whose remote
# names it to Kovan (nothing is ever fetched from or pushed to that address).
set -e
mkdir -p "$HOME" /data/agentd
if [ ! -d /work/sample-shop/.git ]; then
  cp -r /app/demo/sample-shop /work/sample-shop
  cd /work/sample-shop
  git init -q -b main
  git add -A
  git commit -q -m "Sample shop: cart and prices, with tests"
  git remote add origin https://kovan.alperkayan.dev/demo/sample-shop.git
fi
exec node /app/dist/index.js
