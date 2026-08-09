import app from './app.js';

// Vercel imports the Express app. Locally we start a normal HTTP server.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`DealWay running on http://localhost:${port}`));
}

export default app;
