const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  bookingId:{type:String,unique:true},
  user:{type:mongoose.Schema.Types.ObjectId,ref:"User",required:true},
  show:{type:mongoose.Schema.Types.ObjectId,ref:"Show",required:true},
  seats:[String],
  amount:Number,
  paymentStatus:{type:String,enum:["pending","paid","failed","refunded"],default:"pending"},
  bookingStatus:{type:String,enum:["confirmed","cancelled"],default:"confirmed"},
  transactionId:String,
  createdAt:{type:Date,default:Date.now}
});
module.exports=mongoose.model("Booking",schema);
