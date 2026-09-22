const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  name:{type:String,required:true},
  city:{type:String,required:true},
  address:String,
  screenCount:{type:Number,default:1}
});
module.export=mongoose.model("Theatre", schema)
