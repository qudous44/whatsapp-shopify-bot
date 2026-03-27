require('dotenv').config();
const axios = require('axios');
const BASE=process.env.BASE_URL, SHOP=process.env.SHOPIFY_SHOP_DOMAIN, TOKEN=process.env.SHOPIFY_ACCESS_TOKEN;
if(!BASE||!SHOP||!TOKEN){console.error('Fill .env first');process.exit(1);}
const hooks=[
  {topic:'orders/create',    address:BASE+'/webhooks/orders/create',    format:'json'},
  {topic:'checkouts/create', address:BASE+'/webhooks/checkouts/create', format:'json'},
  {topic:'orders/fulfilled', address:BASE+'/webhooks/orders/fulfilled', format:'json'},
];
(async()=>{
  console.log('Registering webhooks for',SHOP,'...');
  for(const wh of hooks){
    try{
      await axios.post(`https://${SHOP}/admin/api/2024-01/webhooks.json`,{webhook:wh},{headers:{'X-Shopify-Access-Token':TOKEN,'Content-Type':'application/json'}});
      console.log('Registered:',wh.topic);
    }catch(e){
      const err=e.response?.data?.errors?.address?.[0]||'';
      if(err.includes('already'))console.log('Already exists:',wh.topic);
      else console.error('Failed:',wh.topic,e.response?.data||e.message);
    }
  }
  console.log('\nDone! Now copy webhook signing secret from Shopify Admin > Settings > Notifications > Webhooks');
})();