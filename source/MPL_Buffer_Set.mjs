export class MPL_Buffer_Set_Entry {
    constructor(SeedID, SequenceNumber, DataMessage) {
        this.SeedID = SeedID;
        this.SequenceNumber = SequenceNumber;
        this.DataMessage = DataMessage;
        this.timer = null;
        this.trickle_E = 0;
        this.valid = true;
    }

    set_timer(timer){
        this.timer = timer;
    }

    get_timer(){
        return this.timer;
    }
    get_SequenceNumber() {
        const result = this.SequenceNumber;
        return result;
    }

    writeover(SeedID, SequenceNumber, DataMessage){
        this.SeedID = SeedID;
        this.SequenceNumber = SequenceNumber;
        this.DataMessage = DataMessage;
        this.timer = null;
        this.trickle_E = 0;
        this.valid = true;
    }

    get_DataMessage() {
        const result = this.DataMessage;
        return result;
    }
    set_invalid(){
        this.valid = false;

    }

    get_expirations(){
        return this.trickle_E;
    }

    increment_expirations(){
        this.trickle_E += 1;
    }

}
