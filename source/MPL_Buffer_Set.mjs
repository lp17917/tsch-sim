export class MPL_Buffer_Set_Entry {
    constructor(SeedID, SequenceNumber, DataMessage) {
        this.SeedID = SeedID;
        this.SequenceNumber = SequenceNumber;
        this.DataMessage = DataMessage;
        this.timer = null;
        this.trickle_E = 0;

    }


    get_SequenceNumber() {
        const result = this.SequenceNumber;
        return result;
    }

    get_DataMessage() {
        const result = this.DataMessage;
        return result;
    }

    increment_expirations(){
        this.trickle_E = this.trickle_E++;
    }

}
