const pkg = require('@shopify/shopify-api');
const s = pkg.shopifyApi();
console.log('shopifyApi() keys:', Object.keys(s));
console.log('Has Context:', !!s.Context);
console.log('Has Shopify:', !!s.Shopify);
console.dir(Object.keys(s).slice(0,50));
