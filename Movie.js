const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  title:{type:String,required:true},
  genre:String,
  language:String,
  duration:String,
  rating:Number,
  description:String,
  poster:String,
  active:{type:Boolean,default:true},
  createdAt:{type:Date,default:Date.now}
});
module.exports=mongoose.model("Movie",schema);
