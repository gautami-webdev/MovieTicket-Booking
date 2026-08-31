const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  movie:{type:mongoose.Schema.Types.ObjectId,ref:"Movie",required:true},
  theatre:{type:mongoose.Schema.Types.ObjectId,ref:"Theatre",required:true},
  screen:{type:String,default:"Screen 1"},
  date:{type:String,required:true},
  time:{type:String,required:true},
  price:{type:Number,required:true},
  seats:[{
    code:String,
    status:{type:String,enum:["available","held","booked"],default:"available"},
    holdToken:String,
    holdUntil:Date
  }]
});
module.exports=mongoose.model("Show",schema);
