import dotenv from "dotenv"
dotenv.config()
import { initDatabase } from "./src/db"
import app from "./src/app"

const PORT = process.env.PORT || 8000

// Init DB
initDatabase()

// Start server
app.listen(PORT, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${PORT}`)
})
