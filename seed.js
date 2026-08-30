const mongoose = require("mongoose");
const Movie = require("./models/Movie");
const Show = require("./models/Show");
const Seat = require("./models/Seat");

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/cinebookDB";
const SHOW_ID = process.env.SHOW_ID || "cinebook-demo-show";

async function seed() {
  await mongoose.connect(MONGO_URI);

  await Movie.updateOne(
    { movieId: "movie-demo" },
    {
      movieId: "movie-demo",
      title: "Movie Night",
      language: "Hindi",
      duration: "2h 30m"
    },
    { upsert: true }
  );

  await Show.updateOne(
    { showId: SHOW_ID },
    {
      showId: SHOW_ID,
      movieId: "movie-demo",
      movieTitle: "Movie Night",
      language: "Hindi",
      format: "2D",
      cinema: "PVR Cinema, City Centre",
      date: "30 August 2026",
      time: "07:30 PM",
      pricePerSeat: 160
    },
    { upsert: true }
  );

  const rows = "ABCDEFGH";
  for (const row of rows) {
    for (let n = 1; n <= 10; n++) {
      const seatId = `${row}${n}`;
      await Seat.updateOne(
        { showId: SHOW_ID, seatId },
        { $setOnInsert: { showId: SHOW_ID, seatId, status: "available", bookingCode: null } },
        { upsert: true }
      );
    }
  }

  // Reset demo seats to available each time seed is run, then book a few seats
  // so the UI shows the Booked state.
  await Seat.updateMany({ showId: SHOW_ID }, { $set: { status: "available", bookingCode: null } });
  await Seat.updateMany(
    { showId: SHOW_ID, seatId: { $in: ["A5", "B6", "C7"] } },
    { $set: { status: "booked", bookingCode: "DEMO1234" } }
  );

  console.log("CineBook database seeded successfully.");
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
