const { getCatalog } = require('./addon/lib/getCatalog');
const { getTrending } = require('./addon/lib/getTrending');

async function run() {
  console.time('Catalog fetch');
  // function getCatalog(type, language, page, id, genre, config)
  const config = {
    rpdbkey: process.env.RPDB_KEY || '',
    topposterskey: process.env.TOPPOSTERS_KEY || ''
  };
  
  try {
    const topMovies = await getCatalog('movie', 'en-US', 1, 'tmdb.top', undefined, config);
    console.timeEnd('Catalog fetch');
    console.log('Got metas:', topMovies.metas.length);
    if(topMovies.metas.length > 0) {
      console.log('First meta info:');
      console.log('- ID:', topMovies.metas[0].id);
      console.log('- Name:', topMovies.metas[0].name);
      console.log('- Full Poster:', topMovies.metas[0].poster);
      console.log('- Poster contains w342:', topMovies.metas[0].poster.includes('w342'));
    }
    
    console.log('---');
    
    console.time('Trending fetch');
    const trendingSeries = await getTrending('series', 'en-US', 1, 'day', config);
    console.timeEnd('Trending fetch');
    console.log('Got metas:', trendingSeries.metas.length);
    if(trendingSeries.metas.length > 0) {
      console.log('First meta info:');
      console.log('- ID:', trendingSeries.metas[0].id);
      console.log('- Name:', trendingSeries.metas[0].name);
      console.log('- Full Poster:', trendingSeries.metas[0].poster);
      console.log('- Poster contains w342:', trendingSeries.metas[0].poster.includes('w342'));
    }
  } catch (error) {
    console.error('Test failed:', error);
  }
}

run();
