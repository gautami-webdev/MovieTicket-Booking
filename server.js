const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");

const Movie = require("./models/Movie");
const Show = require("./models/Show");
const Seat = require("./models/Seat");
const Hold = require("./models/Hold");
const Booking = require("./models/Booking");
const PaymentAttempt = require("./models/PaymentAttempt");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/cinebookDB";
const SHOW_ID = process.env.SHOW_ID || "cinebook-demo-show";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const clients = new Map();

function randomCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function getClient(clientId) {
  return clients.get(clientId);
}

function sendTo(clientId, event) {
  const c = clients.get(clientId);
  if (c?.res) {
    try { c.res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (_) {}
  }
}

function broadcast(event) {
  for (const id of clients.keys()) sendTo(id, event);
}

async function cleanupExpiredHolds() {
  await Hold.deleteMany({ showId: SHOW_ID, expiresAt: { $lte: new Date() } });
}

async function bookedSeatIds() {
  const rows = await Seat.find({ showId: SHOW_ID, status: "booked" }).lean();
  return rows.map(x => x.seatId);
}

async function publicSeatState() {
  await cleanupExpiredHolds();
  const [allSeats, holds] = await Promise.all([
    Seat.find({ showId: SHOW_ID }).lean(),
    Hold.find({ showId: SHOW_ID, expiresAt: { $gt: new Date() } }).lean()
  ]);

  const selectedCounts = {};
  for (const h of holds) {
    for (const id of h.seats) selectedCounts[id] = (selectedCounts[id] || 0) + 1;
  }

  const result = {};
  for (const s of allSeats) {
    result[s.seatId] = {
      status: s.status,
      selectedCount: selectedCounts[s.seatId] || 0
    };
  }
  return result;
}

async function selectedFor(clientId) {
  const hold = await Hold.findOne({ showId: SHOW_ID, clientId, expiresAt: { $gt: new Date() } }).lean();
  return hold ? hold.seats : [];
}

app.post("/api/session", async (req, res) => {
  try {
    const clientId = req.body.clientId || crypto.randomUUID();
    if (!clients.has(clientId)) clients.set(clientId, { res: null });

    const show = await Show.findOne({ showId: SHOW_ID }).lean();
    if (!show) return res.status(500).json({ error: "Demo show not seeded. Run: npm run seed" });

    res.json({
      clientId,
      show: {
        showId: show.showId,
        movieTitle: show.movieTitle,
        language: show.language,
        format: show.format,
        cinema: show.cinema,
        date: show.date,
        time: show.time,
        pricePerSeat: show.pricePerSeat
      },
      seats: await publicSeatState(),
      transactionMinutes: 15
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/events", (req, res) => {
  const clientId = req.query.clientId;
  if (!clientId || !clients.has(clientId)) return res.status(400).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.get(clientId).res = res;
  publicSeatState().then(seats => sendTo(clientId, { type: "state", seats }));

  req.on("close", () => {
    const c = clients.get(clientId);
    if (c) c.res = null;
  });
});

app.get("/api/seats", async (req, res) => {
  res.json({ seats: await publicSeatState() });
});

app.post("/api/select", async (req, res) => {
  try {
    const { clientId, seatIds } = req.body;
    if (!getClient(clientId)) return res.status(400).json({ error: "Session expired." });
    if (!Array.isArray(seatIds) || !seatIds.length) {
      return res.status(400).json({ error: "Select at least one seat." });
    }

    const unique = [...new Set(seatIds)];
    const existing = await Seat.find({
      showId: SHOW_ID,
      seatId: { $in: unique },
      status: "booked"
    }).lean();

    if (existing.length) {
      return res.status(409).json({
        type: "already-booked",
        message: `Seat(s) ${existing.map(x => x.seatId).join(", ")} are already booked. Select any other seat.`,
        seats: await publicSeatState()
      });
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await Hold.findOneAndUpdate(
      { showId: SHOW_ID, clientId },
      { showId: SHOW_ID, clientId, seats: unique, expiresAt },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // New selection cancels any old payment attempt state for this client.
    await PaymentAttempt.deleteMany({ showId: SHOW_ID, clientId });

    broadcast({ type: "state", seats: await publicSeatState() });
    res.json({ ok: true, selectedSeats: unique, transactionEndsAt: expiresAt.getTime() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/cancel", async (req, res) => {
  try {
    const { clientId } = req.body;
    await Hold.deleteOne({ showId: SHOW_ID, clientId });
    await PaymentAttempt.deleteMany({ showId: SHOW_ID, clientId });
    broadcast({ type: "state", seats: await publicSeatState() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
 CASE 3 detection:
 When payment is started, the server records the exact HH:MM:SS second.
 If another user starts payment for the same seat in that same second,
 both users' attempts are marked conflicted before either can complete.
 This leaves the seat available and both clients are returned to selection.
*/
app.post("/api/payment/start", async (req, res) => {
  try {
    const { clientId } = req.body;
    const hold = await Hold.findOne({ showId: SHOW_ID, clientId, expiresAt: { $gt: new Date() } }).lean();
    if (!hold) return res.status(409).json({
      type: "timeout",
      message: "Transaction time expired. Your seats are available again.",
      seats: await publicSeatState()
    });

    const booked = await Seat.find({
      showId: SHOW_ID,
      seatId: { $in: hold.seats },
      status: "booked"
    }).lean();

    if (booked.length) {
      await Hold.deleteOne({ _id: hold._id });
      broadcast({ type: "state", seats: await publicSeatState() });
      return res.status(409).json({
        type: "already-booked",
        message: `Seat ${booked[0].seatId} is already booked. Select any other seat.`,
        seats: await publicSeatState()
      });
    }

    const second = Math.floor(Date.now() / 1000);
    const conflictClients = new Set([clientId]);

    for (const seatId of hold.seats) {
      const existing = await PaymentAttempt.find({
        showId: SHOW_ID,
        seatId,
        second,
        conflicted: false
      }).lean();

      for (const attempt of existing) conflictClients.add(attempt.clientId);

      await PaymentAttempt.create({
        showId: SHOW_ID,
        seatId,
        clientId,
        second,
        conflicted: existing.length > 0
      });

      if (existing.length) {
        await PaymentAttempt.updateMany(
          { showId: SHOW_ID, seatId, second },
          { $set: { conflicted: true } }
        );
      }
    }

    if (conflictClients.size > 1) {
      for (const id of conflictClients) {
        await Hold.deleteOne({ showId: SHOW_ID, clientId: id });
        await PaymentAttempt.updateMany({ showId: SHOW_ID, clientId: id, second }, { $set: { conflicted: true } });
        sendTo(id, {
          type: "payment-conflict",
          message: "Two users attempted payment for the same seat at the same time. Both transactions were cancelled; the seat is available again. Select another seat."
        });
      }
      broadcast({ type: "state", seats: await publicSeatState() });
      return res.status(409).json({
        type: "payment-conflict",
        message: "Same-seat payment happened at the same time. Both transactions were cancelled; the seat is available again.",
        seats: await publicSeatState()
      });
    }

    res.json({ ok: true, paymentStartedAt: second, selectedSeats: hold.seats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/payment/complete", async (req, res) => {
  const { clientId } = req.body;
  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      const hold = await Hold.findOne({
        showId: SHOW_ID,
        clientId,
        expiresAt: { $gt: new Date() }
      }).session(session);

      if (!hold) {
        throw Object.assign(new Error("Transaction time expired. Your seats are available again."), { code: "TIMEOUT" });
      }

      const attempts = await PaymentAttempt.find({
        showId: SHOW_ID,
        clientId,
        conflicted: false
      }).session(session);

      if (!attempts.length) {
        throw Object.assign(new Error("Start payment first."), { code: "NO_PAYMENT" });
      }

      const seatIds = hold.seats;
      const code = randomCode();

      // Atomic condition: only seats that are still available can be booked.
      // If another user already booked one, this update does not match.
      const update = await Seat.updateMany(
        {
          showId: SHOW_ID,
          seatId: { $in: seatIds },
          status: "available"
        },
        { $set: { status: "booked", bookingCode: code } },
        { session }
      );

      if (update.modifiedCount !== seatIds.length) {
        throw Object.assign(
          new Error("One or more selected seats are already booked. Select any other seat."),
          { code: "ALREADY_BOOKED" }
        );
      }

      await Booking.create([{
        bookingId: crypto.randomUUID(),
        showId: SHOW_ID,
        clientId,
        seats: seatIds,
        bookingCode: code,
        amount: seatIds.length * 160,
        paymentMethod: "counter",
        status: "confirmed"
      }], { session });

      await Hold.deleteOne({ _id: hold._id }).session(session);
      await PaymentAttempt.deleteMany({ showId: SHOW_ID, clientId }).session(session);

      result = { code, selectedSeats: seatIds };
    });

    // Tell other users that may have selected the now-booked seat(s).
    const allHolds = await Hold.find({
      showId: SHOW_ID,
      seats: { $in: result.selectedSeats }
    }).lean();

    for (const other of allHolds) {
      await Hold.deleteOne({ _id: other._id });
      sendTo(other.clientId, {
        type: "seat-booked",
        message: `A seat you selected (${result.selectedSeats.join(", ")}) is already booked. Select any other seat.`
      });
    }

    broadcast({ type: "state", seats: await publicSeatState() });
    res.json({
      ok: true,
      type: "complete",
      code: result.code,
      selectedSeats: result.selectedSeats,
      message: "Transaction complete."
    });
  } catch (err) {
    const code = err.code;
    const messages = {
      TIMEOUT: "Transaction timed out. The seat is available again.",
      ALREADY_BOOKED: "A selected seat is already booked. Select any other seat.",
      NO_PAYMENT: "Start payment first."
    };
    if (["TIMEOUT", "ALREADY_BOOKED"].includes(code)) {
      await Hold.deleteOne({ showId: SHOW_ID, clientId });
      await PaymentAttempt.deleteMany({ showId: SHOW_ID, clientId });
      broadcast({ type: "state", seats: await publicSeatState() });
      return res.status(409).json({
        type: code === "TIMEOUT" ? "timeout" : "already-booked",
        message: messages[code],
        seats: await publicSeatState()
      });
    }
    if (code === "NO_PAYMENT") return res.status(400).json({ error: messages[code] });
    res.status(500).json({ error: err.message });
  } finally {
    await session.endSession();
  }
});

app.get("/api/receipt", async (req, res) => {
  const { movie, cinema, date, time, seats: seatParam, code, amount } = req.query;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="cinebook-receipt.pdf"');

  const doc = new PDFDocument({ size: "A4", margin: 55 });
  doc.pipe(res);
  doc.fontSize(25).text("CINEBOOK", { align: "center" });
  doc.moveDown();
  doc.fontSize(18).text("Movie Ticket Booking Receipt", { align: "center" });
  doc.moveDown(2);
  doc.fontSize(12);
  doc.text(`Movie: ${movie || "Movie"}`);
  doc.text(`Cinema: ${cinema || "Cinema"}`);
  doc.text(`Date: ${date || "—"}`);
  doc.text(`Show Time: ${time || "—"}`);
  doc.text(`Selected Seat(s): ${seatParam || "—"}`);
  doc.text(`Amount: ₹${amount || "0"}`);
  doc.moveDown();
  doc.fontSize(17).text(`Booking Code: ${code || "—"}`);
  doc.moveDown();
  doc.fontSize(13).text("Show this receipt at the counter to pay and get the ticket.");
  doc.end();
});

app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB connected:", MONGO_URI);
    app.listen(PORT, () => console.log(`CineBook running at http://localhost:${PORT}`));

    setInterval(async () => {
      try {
        await cleanupExpiredHolds();
        broadcast({ type: "state", seats: await publicSeatState() });
      } catch (e) {
        console.error("Cleanup:", e.message);
      }
    }, 5000);
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
    console.error("Make sure MongoDB is running, then run: npm run seed");
    process.exit(1);
  }
}

start();
